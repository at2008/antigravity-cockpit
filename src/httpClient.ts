import axios from 'axios';

export interface HttpResponse<T = any> {
    status: number;
    statusText: string;
    data: T;
}

export interface HttpRequestConfig {
    headers?: Record<string, string>;
    timeout?: number;
}

export interface HttpRequestOptions extends HttpRequestConfig {
    url: string;
    method: 'GET' | 'POST';
    data?: any;
}

interface OriginalFetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}

type OriginalFetchFn = (input: string, init?: Record<string, any>) => Promise<OriginalFetchResponse>;

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * 判断异常是否属于 BoringSSL / OpenSSL 的 TLS BAD_DECRYPT 错误。
 * 会沿 cause 链向下排查，兼容 Axios 与 Node TLS 包装后的错误结构。
 */
export function isTlsBadDecryptError(err: unknown): boolean {
    const visited = new Set<unknown>();
    let current: any = err;
    let depth = 0;

    while (current && typeof current === 'object' && depth < 5 && !visited.has(current)) {
        visited.add(current);

        if (current.code === 'ERR_SSL_BAD_DECRYPT') {
            return true;
        }
        if (typeof current.message === 'string' && /BAD_DECRYPT/i.test(current.message)) {
            return true;
        }
        if (typeof current.reason === 'string' && /BAD_DECRYPT/i.test(current.reason)) {
            return true;
        }

        current = current.cause;
        depth += 1;
    }

    return false;
}

/**
 * 获取 VS Code 扩展宿主在注入 proxy-agent 补丁前保留的原生 fetch。
 */
function getVscodeOriginalFetch(): OriginalFetchFn | null {
    const candidate = (globalThis as any).__vscodeOriginalFetch;
    return typeof candidate === 'function' ? (candidate as OriginalFetchFn) : null;
}

function hasHeaderIgnoreCase(headers: Record<string, string>, name: string): boolean {
    const target = name.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === target);
}

function parseResponseBody(rawText: string): any {
    if (!rawText) {
        return '';
    }
    try {
        return JSON.parse(rawText);
    } catch {
        return rawText;
    }
}

/**
 * 使用 VS Code 保留的原生 fetch 发起降级请求，并对齐 Axios 的返回与错误结构。
 */
async function requestWithOriginalFetch<T>(
    originalFetch: OriginalFetchFn,
    options: HttpRequestOptions
): Promise<HttpResponse<T>> {
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = { ...(options.headers || {}) };
    const init: Record<string, any> = {
        method: options.method,
        headers,
    };

    if (options.method !== 'GET' && options.data !== undefined) {
        if (
            typeof options.data === 'string' ||
            options.data instanceof URLSearchParams ||
            Buffer.isBuffer(options.data)
        ) {
            init.body = options.data;
        } else {
            init.body = JSON.stringify(options.data);
            if (!hasHeaderIgnoreCase(headers, 'Content-Type')) {
                headers['Content-Type'] = 'application/json';
            }
        }
    }

    const AbortControllerCtor = (globalThis as any).AbortController;
    let controller: any = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs > 0 && typeof AbortControllerCtor === 'function') {
        controller = new AbortControllerCtor();
        init.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let res: OriginalFetchResponse;
    try {
        res = await originalFetch(options.url, init);
    } catch (fetchErr: any) {
        if (fetchErr && fetchErr.name === 'AbortError') {
            const timeoutErr: any = new Error(`timeout of ${timeoutMs}ms exceeded`);
            timeoutErr.code = 'ECONNABORTED';
            throw timeoutErr;
        }
        throw fetchErr;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }

    const rawText = await res.text();
    const parsedData = parseResponseBody(rawText);

    if (!res.ok) {
        const httpErr: any = new Error(`Request failed with status code ${res.status}`);
        httpErr.response = {
            status: res.status,
            statusText: res.statusText || '',
            data: parsedData,
        };
        throw httpErr;
    }

    return {
        status: res.status,
        statusText: res.statusText || 'OK',
        data: parsedData as T,
    };
}

/**
 * 统一 HTTP 请求入口：
 * 1. 默认走 axios（保留 VS Code http.proxy / proxyStrictSSL 等代理能力）；
 * 2. 仅当触发 BoringSSL ERR_SSL_BAD_DECRYPT 且存在 __vscodeOriginalFetch 时，自动无感降级重试。
 */
export async function httpRequest<T = any>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

    try {
        const res = await axios.request<T>({
            url: options.url,
            method: options.method,
            data: options.data,
            headers: options.headers,
            timeout: timeoutMs,
        });
        return {
            status: res.status,
            statusText: res.statusText || 'OK',
            data: res.data,
        };
    } catch (err: any) {
        if (isTlsBadDecryptError(err)) {
            const originalFetch = getVscodeOriginalFetch();
            if (originalFetch) {
                const safeUrl = options.url.split('?')[0];
                console.warn(`[Cockpit] 检测到 TLS BAD_DECRYPT，自动降级使用 __vscodeOriginalFetch 重试: ${options.method} ${safeUrl}`);
                return await requestWithOriginalFetch<T>(originalFetch, options);
            }
        }
        throw err;
    }
}

export function httpGet<T = any>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return httpRequest<T>({ url, method: 'GET', ...config });
}

export function httpPost<T = any>(url: string, data?: any, config?: HttpRequestConfig): Promise<HttpResponse<T>> {
    return httpRequest<T>({ url, method: 'POST', data, ...config });
}
