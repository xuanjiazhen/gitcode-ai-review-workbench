export async function collectGitCodeAudit({ token, onProgress = () => {}, request = fetch, signal } = {}) {
  const organization = 'Cangjie';
  const apiOrigin = 'https://web-api.gitcode.com';
  const gitCodeOrigin = 'https://gitcode.com';
  const settingsSuffix = '/setting/apps/atomcode_ai_review';

  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('需要已登录的 GitCode 会话。');
  }

  async function get(path, params) {
    const url = new URL(path, apiOrigin);
    url.search = new URLSearchParams(params);
    let response;
    try {
      response = await request(url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token.trim()}`,
          'X-App-Channel': 'gitcode-fe',
          'X-Platform': 'web',
        },
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { error: '网络请求失败' };
    }

    try {
      const body = await response.json();
      const errorCode = body?.error_code_name;
      const invalidToken = errorCode === 'TOKEN_INVALID_ERROR' || errorCode === 'TOKEN_EXPIRED';
      if (!response.ok) return { error: `HTTP ${response.status}`, status: response.status, invalidToken };
      if (body === null || typeof body !== 'object') return { error: '返回格式异常' };
      if (body.error_code) return { error: 'GitCode API 返回错误', invalidToken };
      return { body };
    } catch {
      if (!response.ok) return { error: `HTTP ${response.status}`, status: response.status };
      return { error: '返回格式异常' };
    }
  }

  function cleanUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  function normalizeProject(project) {
    const path = project.path_with_namespace;
    const projectId = Number(project.id);
    const pathParts = typeof path === 'string' ? path.split('/') : [];
    const validPath = pathParts.length > 1 && pathParts[0].toLowerCase() === organization.toLowerCase() &&
      pathParts.every((part) => part && part !== '.' && part !== '..' && !/[\\?#\s]/.test(part));
    if (!validPath || !Number.isSafeInteger(projectId) || projectId < 1) {
      throw new Error('GitCode 仓库清单中的路径或项目 ID 无法识别。');
    }

    const url = `${gitCodeOrigin}/${pathParts.map(encodeURIComponent).join('/')}`;
    return {
      path,
      name: pathParts.at(-1),
      projectId,
      url,
      settingsUrl: `${url}${settingsSuffix}`,
      description: typeof project.description === 'string' ? project.description : '',
      language: Array.isArray(project.main_repository_language) ? project.main_repository_language[0] ?? '' : '',
      archived: project.archived === true,
    };
  }

  async function listProjects() {
    const projects = [];
    let page = 1;
    let total;
    let pageCount;

    do {
      const { body, error, invalidToken } = await get(`/api/v2/groups/${organization}/projects`, {
        orgId: organization,
        page,
        per_page: 100,
        simple: false,
        order_by: 'name',
        sort: 'asc',
        repo_type: '0,1,2',
        include_subgroups: true,
      });
      if (invalidToken) throw new Error('GitCode 登录已失效，请重新登录后重试。');
      if (error) throw new Error(`无法读取组织仓库清单（${error}）。`);
      if (!Array.isArray(body.content) || !Number.isSafeInteger(body.total) ||
          body.total < 1 || !Number.isSafeInteger(body.page_count) || body.page_count < 1 ||
          body.page_num !== page) {
        throw new Error('GitCode 返回的组织仓库清单无法核实。');
      }

      total ??= body.total;
      pageCount ??= body.page_count;
      if (body.total !== total || body.page_count !== pageCount) {
        throw new Error('组织仓库清单在采集期间发生变化，请重新采集。');
      }

      projects.push(...body.content.map(normalizeProject));
      page += 1;
    } while (page <= pageCount);

    const distinctPaths = new Set(projects.map(({ path }) => path.toLowerCase()));
    if (projects.length !== total || distinctPaths.size !== total) {
      throw new Error('组织仓库清单的分页结果不完整，请重新采集。');
    }
    return projects;
  }

  function normalizeSkills(items, settingsUrl) {
    if (!Array.isArray(items)) return null;

    const skills = [];
    for (const skill of items) {
      if (!skill || typeof skill.name !== 'string' || !skill.name.trim() || typeof skill.enabled !== 'boolean') {
        return null;
      }
      const updatedTime = skill.updated_time;
      let updatedAt;
      if (typeof updatedTime === 'string' || typeof updatedTime === 'number') {
        const value = String(updatedTime).trim();
        const timestamp = /^\d+$/.test(value) ? Number(value) * (value.length === 10 ? 1_000 : 1) : value;
        const date = new Date(timestamp);
        if (Number.isFinite(date.getTime())) updatedAt = date.toISOString();
      }
      skills.push({
        name: skill.name,
        enabled: skill.enabled,
        url: cleanUrl(skill.url),
        description: typeof skill.description === 'string' ? skill.description : '',
        updatedAt,
        updateUrl: settingsUrl,
      });
    }
    return skills;
  }

  async function readProject(project) {
    const params = { scope: 1, project_id: project.projectId };
    const [config, skillList] = await Promise.all([
      get('/api/v2/namespaces/namespace-configs', params),
      get('/api/v2/namespaces/review-skills', params),
    ]);
    if (config.invalidToken || skillList.invalidToken) throw new Error('GitCode 登录已失效，请重新登录后重试。');
    const review = config.body?.data?.config?.base_config?.code_review;
    const aiReview = typeof review?.disable === 'boolean' ? !review.disable : null;
    const auto = review?.pull_request_opened?.code_review;
    const autoReview = typeof auto === 'boolean' ? auto : null;
    const skills = normalizeSkills(skillList.body?.data?.items, project.settingsUrl);
    const notes = [];
    if (aiReview === null || autoReview === null) notes.push(`基础配置：${config.error ?? '状态字段缺失'}`);
    if (skills === null) notes.push(`Skill 列表：${skillList.error ?? '数据缺失或返回格式异常'}`);
    const authFailed = config.status === 401 && skillList.status === 401;

    return {
      repository: {
        ...project,
        aiReview,
        autoReview,
        skills,
        checkedAt: new Date().toISOString(),
        ...(notes.length ? { note: notes.join('；') } : {}),
      },
      authFailed,
    };
  }

  const projects = await listProjects();
  const repositories = [];
  onProgress({ done: 0, total: projects.length });
  let authFailures = 0;

  for (let start = 0; start < projects.length; start += 3) {
    const batch = await Promise.all(projects.slice(start, start + 3).map(readProject));
    authFailures += batch.filter(({ authFailed }) => authFailed).length;
    repositories.push(...batch.map(({ repository }) => repository));
    onProgress({ done: repositories.length, total: projects.length });
  }

  if (authFailures === repositories.length) {
    throw new Error('GitCode 拒绝了设置查询（HTTP 401），请在 GitCode 重新登录并确认账号可以查看仓库设置。');
  }

  return { version: 1, organization, repositories };
}

async function runInBrowser(collect) {
  if (location.origin !== 'https://gitcode.com') {
    alert('请先打开并登录 https://gitcode.com，再点击「采集 AI 检视」书签。');
    return;
  }
  const token = localStorage.getItem('access_token');
  if (!token) {
    alert('当前 GitCode 页面没有已登录会话，请登录后重试。');
    return;
  }

  const dialogId = 'gitcode-ai-audit-collector';
  const existing = document.getElementById(dialogId);
  if (existing) return;
  const controller = new AbortController();
  const dialog = document.createElement('dialog');
  dialog.id = dialogId;
  dialog.setAttribute('aria-label', '采集 AI 检视');
  dialog.style.cssText = 'max-width:min(430px,90vw);padding:24px;border:1px solid #8e98a8;border-radius:12px;background:#fff;color:#172336;font:15px/1.6 system-ui;box-shadow:0 16px 48px #0004';

  const title = document.createElement('strong');
  title.textContent = '采集 Cangjie AI 检视';
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.textContent = '正在读取仓库清单…';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.style.cssText = 'padding:6px 12px;border:1px solid #8e98a8;border-radius:6px;background:#fff;color:#172336;cursor:pointer';
  close.onclick = () => dialog.close();
  actions.append(close);
  dialog.append(title, message, actions);
  dialog.addEventListener('close', () => {
    controller.abort();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();

  try {
    const snapshot = await collect({
      token,
      signal: controller.signal,
      onProgress: ({ done, total }) => {
        message.textContent = `正在读取仓库设置 ${done} / ${total}…`;
      },
    });
    const count = snapshot.repositories.length;
    const incomplete = snapshot.repositories.filter(({ aiReview, autoReview, skills }) =>
      aiReview === null || autoReview === null || skills === null).length;
    message.textContent = `已读取 ${count} 个仓库，${incomplete} 个仓库有待核实的设置。下载 JSON 后导入工作台。`;
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = '下载 JSON';
    download.style.cssText = 'padding:6px 12px;border:1px solid #172336;border-radius:6px;background:#172336;color:#fff;cursor:pointer';
    download.onclick = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'cangjie-ai-review-audit.json';
      dialog.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    actions.prepend(download);
    download.focus();
  } catch (error) {
    if (!controller.signal.aborted) message.textContent = error.message;
  }
}

export function bookmarkletHref() {
  const code = `void (${runInBrowser.toString()})(${collectGitCodeAudit.toString()});`;
  return `javascript:${encodeURIComponent(code)}`;
}
