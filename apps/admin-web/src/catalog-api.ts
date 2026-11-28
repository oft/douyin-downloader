export const jsonHeaders = { 'Content-Type': 'application/json' };

export async function catalogApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/catalog/${path}`, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
    return body as T;
}
