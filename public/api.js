/** 后端接口封装。错误统一带上 status / fields / code。 */

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `请求失败（${res.status}）`);
    err.status = res.status;
    if (data && data.error) {
      err.fields = data.error.fields;
      err.code = data.error.code;
    }
    throw err;
  }
  return data;
}

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  login: (username, password) => request('/api/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/logout', { method: 'POST' }),
  apply: (payload) => request('/api/register-request', { method: 'POST', body: payload }),

  listItems: () => request('/api/items'),
  createItem: (payload) => request('/api/items', { method: 'POST', body: payload }),
  updateItem: (id, payload) => request(`/api/items/${id}`, { method: 'PATCH', body: payload }),
  archiveItem: (id, version) => request(`/api/items/${id}/archive`, { method: 'POST', body: { version } }),
  deleteItem: (id) => request(`/api/items/${id}`, { method: 'DELETE' }),

  owners: () => request('/api/owners'),

  invites: () => request('/api/invites'),
  invite: (itemId, accountId) =>
    request(`/api/items/${itemId}/invites`, { method: 'POST', body: { account_id: accountId } }),
  acceptInvite: (id) => request(`/api/invites/${id}/accept`, { method: 'POST' }),
  rejectInvite: (id) => request(`/api/invites/${id}/reject`, { method: 'POST' }),

  adminRequests: () => request('/api/admin/requests'),
  approve: (id) => request(`/api/admin/requests/${id}/approve`, { method: 'POST' }),
  reject: (id) => request(`/api/admin/requests/${id}/reject`, { method: 'POST' }),
  adminAccounts: () => request('/api/admin/accounts'),
  setRole: (id, role) => request(`/api/admin/accounts/${id}`, { method: 'PATCH', body: { role } }),
  deleteAccount: (id) => request(`/api/admin/accounts/${id}`, { method: 'DELETE' }),
  transferItems: (id, toAccountId) =>
    request(`/api/admin/accounts/${id}/transfer`, { method: 'POST', body: { to_account_id: toAccountId } }),
  archiveList: () => request('/api/admin/archive'),
};
