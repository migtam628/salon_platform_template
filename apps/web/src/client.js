import { Account, Client, ID } from 'appwrite';

// Preview access must be opted into explicitly; production builds default to authenticated mode.
export const demoMode = import.meta.env.VITE_DEMO_MODE === 'true';
const endpoint = import.meta.env.VITE_APPWRITE_ENDPOINT;
const projectId = import.meta.env.VITE_APPWRITE_PROJECT_ID;
export const authConfigured = Boolean(endpoint && projectId);
const client = authConfigured ? new Client().setEndpoint(endpoint).setProject(projectId) : null;
export const account = client ? new Account(client) : null;

export async function api(path, options = {}, role = 'customer') {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (authConfigured && account && !demoMode) {
    try { const session = await account.createJWT(); headers.authorization = `Bearer ${session.jwt}`; } catch { /* Public APIs can still be accessed. */ }
  }
  if (demoMode) headers['x-demo-role'] = role;
  const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
export async function signIn(email, password) {
  if (!account) throw new Error('Appwrite authentication has not been configured.');
  return account.createEmailPasswordSession({ email, password });
}
export async function signUp(name, email, password) {
  if (!account) throw new Error('Appwrite authentication has not been configured.');
  return account.create({ userId: ID.unique(), name, email, password });
}
export async function currentUser() {
  if (demoMode) return { $id: 'demo-customer', name: 'Taylor Morgan', email: 'guest@demo.invalid' };
  try { return await account?.get(); } catch { return null; }
}
