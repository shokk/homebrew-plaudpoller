export interface PlaudCredentials {
  email: string;
  password: string;
  region: 'us' | 'eu';
}

export interface PlaudTokenData {
  accessToken: string;
  tokenType: string;
  issuedAt: number;   // epoch ms
  expiresAt: number;  // epoch ms (decoded from JWT)
}

export interface PlaudConfig {
  credentials?: PlaudCredentials;
  token?: PlaudTokenData;
}

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
};

// Plaud's API rejects requests with the default Node.js fetch User-Agent
// ("node") with 403 Forbidden, so we send a browser-like UA on every request.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// HTTP transport abstraction. Defaults to `fetch` (Node/CLI), but hosts that
// can't use cross-origin fetch — e.g. an Obsidian plugin running in the
// renderer, which is blocked by CORS — can inject their own requester
// (Obsidian's `requestUrl`).
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type Requester = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchRequester: Requester = async (req) => {
  const res = await fetch(req.url, {
    method: req.method ?? 'GET',
    headers: { 'User-Agent': USER_AGENT, ...req.headers },
    body: req.body,
  });
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    arrayBuffer: () => res.arrayBuffer(),
  };
};

export interface PlaudRecording {
  id: string;
  filename: string;
  fullname: string;
  filesize: number;
  duration: number;
  start_time: number;
  end_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  keywords: string[];
  serial_number: string;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  transcript: string;
  summary?: string;
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  country: string;
  membership_type: string;
}
