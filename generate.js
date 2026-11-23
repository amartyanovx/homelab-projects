#!/usr/bin/env node
'use strict';

/**
 * Генератор статической страницы со списком репозиториев GitHub.
 *
 * Запуск:
 *   node generate.js [username]
 *
 * Пользователь: аргумент -> GITHUB_USER -> DEFAULT_USER.
 * Токен (для приватных репозиториев и повышенного лимита API):
 *   GITHUB_TOKEN или GH_TOKEN; если их нет — `gh auth token`.
 *
 * Страница: index.html рядом со скриптом (готово для GitHub Pages).
 */

const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const DEFAULT_USER = 'amartyanovx';
const DEFAULT_RESULT = 'WIP';
const INCLUDE_PRIVATE = true;
const EXCLUDED_REPOS = ['homelab-projects'];
const OUTPUT_FILE = join(__dirname, 'index.html');
const PER_PAGE = 100;
const MAX_PAGES = 10;
const MAX_PURPOSE_LENGTH = 400;
const REQUEST_TIMEOUT_MS = 15000;

const user = (process.argv[2] || process.env.GITHUB_USER || DEFAULT_USER).trim();
let token = '';

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function githubApi(path, accept = 'application/vnd.github+json') {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: accept,
      'User-Agent': 'homelab-projects-generator',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function describeError(response) {
  if (response.status === 404) return `пользователь «${user}» не найден`;
  if (response.status === 403 || response.status === 429) {
    return 'похоже, исчерпан лимит запросов — укажите GITHUB_TOKEN или выполните `gh auth login`';
  }
  return response.statusText || 'неизвестная ошибка';
}

async function fetchViewer() {
  if (!token) return '';
  const response = await githubApi('/user');
  if (!response.ok) return '';
  const viewer = await response.json();
  return viewer.login || '';
}

function isExcludedRepo(repo) {
  return EXCLUDED_REPOS.some((name) => name.toLowerCase() === repo.name.toLowerCase());
}

/**
 * Репозитории запрошенного пользователя. Собственный репозиторий страницы
 * (и всё, что перечислено в EXCLUDED_REPOS) в список не попадает.
 * Если токен принадлежит тому же пользователю, используется /user/repos —
 * этот эндпоинт отдаёт и приватные репозитории (при scope `repo`).
 * Для чужого аккаунта доступны только публичные репозитории.
 */
async function fetchRepos() {
  const viewer = await fetchViewer();
  const ownAccount = Boolean(viewer) && viewer.toLowerCase() === user.toLowerCase();
  const visibility = INCLUDE_PRIVATE ? 'all' : 'public';
  const query = ownAccount
    ? `/user/repos?affiliation=owner&visibility=${visibility}&sort=full_name&per_page=${PER_PAGE}`
    : `/users/${encodeURIComponent(user)}/repos?type=owner&sort=full_name&per_page=${PER_PAGE}`;

  console.log(
    ownAccount
      ? `Режим: свой аккаунт, приватные репозитории ${INCLUDE_PRIVATE ? 'включены' : 'исключены'}`
      : 'Режим: только публичные репозитории (токен не от этого аккаунта)',
  );

  const repos = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await githubApi(`${query}&page=${page}`);
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${describeError(response)}`);
    }
    const batch = await response.json();
    repos.push(...batch);
    if (batch.length < PER_PAGE) break;
  }

  const excluded = repos.filter(isExcludedRepo);
  if (excluded.length) {
    console.log(`Исключено из списка: ${excluded.map((repo) => repo.name).join(', ')}`);
  }
  return repos.filter((repo) => !isExcludedRepo(repo));
}

/**
 * Публичные репозитории идут первыми, приватные — ниже;
 * внутри каждой группы сортировка по имени.
 */
function sortRepos(repos) {
  return repos.sort((a, b) => {
    if (a.private !== b.private) return a.private ? 1 : -1;
    return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
  });
}

async function fetchReadme(repo) {
  const response = await githubApi(`/repos/${repo.full_name}/readme`, 'application/vnd.github.raw+json');
  if (response.status === 404) return '';
  if (!response.ok) {
    console.warn(`  ! README ${repo.full_name}: HTTP ${response.status}`);
    return '';
  }
  return response.text();
}

/**
 * Достаёт назначение проекта из README: первый осмысленный абзац без
 * заголовков, бейджей, картинок и блоков кода. Длинный текст обрезается.
 */
function extractPurpose(readme, fallback) {
  if (!readme) return fallback;

  const cleaned = readme
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '');

  // Строки, состоящие только из картинок/бейджей/центрирующих обёрток, не нужны.
  const withoutMedia = cleaned
    .split('\n')
    .filter((line) => !/^\s*(?:\[?!\[|<img\b|<picture\b|<p\b|<div\b|<a\b)/i.test(line))
    .join('\n');

  for (const block of withoutMedia.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const firstLine = trimmed.split('\n')[0].trim();
    if (/^#{1,6}\s/.test(firstLine)) continue;
    if (/^\|/.test(firstLine)) continue;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(firstLine)) continue;

    const text = inlineToText(trimmed);
    if (text.length >= 3) return truncate(text, MAX_PURPOSE_LENGTH);
  }

  return fallback;
}

function inlineToText(markdown) {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^\s*>\s?/, ''))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function renderCard({ repo, purpose }) {
  const name = escapeHtml(repo.name);
  const repository = repo.private
    ? '<span class="card__private">Private</span>'
    : `<a class="card__link" href="${escapeHtml(repo.html_url)}">${escapeHtml(repo.full_name)}</a>`;

  return `      <article class="card">
        <h2 class="card__title">${name}</h2>
        <div class="card__field">
          <span class="card__label">Repository</span>
          ${repository}
        </div>
        <div class="card__field">
          <span class="card__label">Purpose</span>
          <p class="card__purpose">${escapeHtml(purpose)}</p>
        </div>
        <div class="card__field card__field--result">
          <span class="card__label">Result</span>
          <span class="card__result">${escapeHtml(DEFAULT_RESULT)}</span>
        </div>
      </article>`;
}

function renderPage(projects) {
  const generatedAt = new Date().toISOString().slice(0, 10);
  const cards = projects.length
    ? projects.map(renderCard).join('\n')
    : '      <p class="empty">No repositories found.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="GitHub projects of ${escapeHtml(user)}">
  <title>Homelab Projects</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #1e1e1e;
      --bg-card: #272727;
      --border: #303030;
      --fg: #c5c8c6;
      --fg-muted: #9a9b99;
      --link: #6089b4;
      --mono: ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, monospace;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
    }

    ::selection { background: #676b7180; }

    .page {
      max-width: 880px;
      margin: 0 auto;
      padding: 48px 24px 64px;
    }

    .page__header {
      padding-bottom: 16px;
      margin-bottom: 32px;
      border-bottom: 1px solid var(--border);
    }

    .page__title {
      margin: 0;
      font-size: 26px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }

    .page__meta {
      margin: 6px 0 0;
      color: var(--fg-muted);
      font-family: var(--mono);
      font-size: 12px;
    }

    .card {
      margin-bottom: 24px;
      padding: 20px 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
    }

    .card__title {
      margin: 0 0 14px;
      font-size: 18px;
      font-weight: 600;
    }

    .card__field {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 12px;
      align-items: baseline;
    }

    .card__field + .card__field { margin-top: 10px; }

    /* Блок Result отделён от предыдущего поля дополнительными 8px. */
    .card__field.card__field--result { margin-top: 18px; }

    .card__label {
      color: var(--fg-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }

    .card__link {
      color: var(--link);
      font-family: var(--mono);
      font-size: 13px;
      text-decoration: none;
      word-break: break-all;
    }

    .card__link:hover { text-decoration: underline; }

    .card__private { color: var(--fg); }

    .card__purpose {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin: 0;
    }

    .card__result {
      justify-self: start;
      font-size: 14px;
    }

    .empty { color: var(--fg-muted); }

    .page__footer {
      margin-top: 40px;
      color: var(--fg-muted);
      font-family: var(--mono);
      font-size: 12px;
    }

    @media (max-width: 560px) {
      .page { padding: 32px 16px 48px; }

      .card { padding: 16px; }

      .card__field {
        grid-template-columns: 1fr;
        gap: 2px;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="page__header">
      <h1 class="page__title">Homelab Projects</h1>
      <p class="page__meta">${escapeHtml(user)} · repositories: ${projects.length} · updated ${generatedAt}</p>
    </header>

    <section class="cards">
${cards}
    </section>

    <footer class="page__footer">Generated by generate.js</footer>
  </main>
</body>
</html>
`;
}

async function main() {
  token = resolveToken();
  console.log(`GitHub: ${user}${token ? ' (токен найден)' : ' (без токена, лимит API — 60 запросов/час)'}`);

  const repos = await fetchRepos();
  sortRepos(repos);
  console.log(`Репозиториев: ${repos.length}`);

  const projects = [];
  for (const [index, repo] of repos.entries()) {
    const readme = await fetchReadme(repo);
    const purpose = extractPurpose(readme, repo.description || 'No description provided.');
    projects.push({ repo, purpose });
    console.log(`  [${index + 1}/${repos.length}] ${repo.name}`);
  }

  writeFileSync(OUTPUT_FILE, renderPage(projects), 'utf8');
  console.log(`\nГотово: ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nОшибка: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { extractPurpose, truncate, escapeHtml, renderPage, renderCard, sortRepos, isExcludedRepo };


