import { createLogger } from './logger';

const log = createLogger('github');

const REPO_OWNER = 'diyoriko';
const REPO_NAME = 'sami';
const BACKLOG_PATH = 'COMMUNITY_TASKS.md';
const BRANCH = 'main';

function getToken(): string | null {
  return process.env.GITHUB_TOKEN ?? null;
}

interface GitHubFile {
  content: string;  // base64
  sha: string;
}

async function getFile(filePath: string): Promise<GitHubFile | null> {
  const token = getToken();
  if (!token) return null;

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) {
    log.error('GitHub getFile failed', { status: res.status, path: filePath });
    return null;
  }

  const data = await res.json() as { content: string; sha: string };
  return { content: data.content, sha: data.sha };
}

async function putFile(filePath: string, content: string, sha: string, message: string): Promise<boolean> {
  const token = getToken();
  if (!token) return false;

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha,
      branch: BRANCH,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log.error('GitHub putFile failed', { status: res.status, body: body.slice(0, 200) });
    return false;
  }

  log.info('GitHub file updated', { path: filePath });
  return true;
}

/**
 * Insert a task into COMMUNITY_TASKS.md under the appropriate priority section.
 * Returns the updated file content or null if insertion point not found.
 */
export function insertTaskIntoBacklog(markdown: string, task: string, priority: string): string | null {
  // Find the P2 section matching the priority
  // Task format: "- [ ] **Title** — description"
  const taskLine = `- [ ] ${task}`;

  // Strategy: find the target priority section and append the task there
  // P2 sections: look for "### P2:" headers and find the most appropriate one
  // Default: append to "### P2: Автоматизация" or after last P2 section

  const lines = markdown.split('\n');
  let insertIdx = -1;

  if (priority === 'P1') {
    // Find "### P1:" section that's "в работе" or the last P1 section
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^### P1:/.test(lines[i]) && !lines[i].includes('DONE')) {
        // Find end of this section (next ### or end)
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith('### ') && !lines[j].startsWith('## ')) j++;
        insertIdx = j;
        break;
      }
    }
  } else {
    // P2: find last P2 section
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^### P2:/.test(lines[i]) && !lines[i].includes('~~')) {
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith('### ') && !lines[j].startsWith('## ')) j++;
        insertIdx = j;
        break;
      }
    }
  }

  // Fallback: insert before P3
  if (insertIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/^### P3:/.test(lines[i])) {
        insertIdx = i;
        break;
      }
    }
  }

  if (insertIdx === -1) return null;

  // Check for duplicates (fuzzy: first 40 chars of task)
  const taskStart = task.slice(0, 40).toLowerCase();
  const isDuplicate = lines.some(line =>
    line.toLowerCase().includes(taskStart)
  );
  if (isDuplicate) {
    log.info('task already exists in backlog, skipping', { task: task.slice(0, 50) });
    return null;
  }

  lines.splice(insertIdx, 0, taskLine, '');
  return lines.join('\n');
}

/**
 * Add a task to COMMUNITY_TASKS.md via GitHub API.
 * Returns true if successful, error message if not.
 */
export async function addTaskToBacklog(task: string, priority: string): Promise<{ ok: boolean; error?: string }> {
  const token = getToken();
  if (!token) {
    return { ok: false, error: 'GITHUB_TOKEN не настроен. Добавь токен в Railway env.' };
  }

  const file = await getFile(BACKLOG_PATH);
  if (!file) {
    return { ok: false, error: 'Не удалось получить COMMUNITY_TASKS.md из GitHub' };
  }

  const currentContent = Buffer.from(file.content, 'base64').toString('utf-8');
  const updatedContent = insertTaskIntoBacklog(currentContent, task, priority);

  if (!updatedContent) {
    return { ok: false, error: 'Задача уже в бэклоге или не найдена секция для вставки' };
  }

  const commitMsg = `feat(backlog): добавлена задача от стратега — ${task.slice(0, 60)}`;
  const success = await putFile(BACKLOG_PATH, updatedContent, file.sha, commitMsg);

  if (!success) {
    return { ok: false, error: 'Не удалось обновить файл на GitHub' };
  }

  return { ok: true };
}
