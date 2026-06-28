import { PlaudAuth } from './auth.js';
import { BASE_URLS, fetchRequester } from './types.js';
import type { PlaudRecording, PlaudRecordingDetail, PlaudUserInfo, Requester } from './types.js';

export class PlaudClient {
  private auth: PlaudAuth;
  private region: string;
  private requester: Requester;

  constructor(auth: PlaudAuth, region: string = 'us', requester: Requester = fetchRequester) {
    this.auth = auth;
    this.region = region;
    this.requester = requester;
  }

  private get baseUrl(): string {
    return BASE_URLS[this.region] ?? BASE_URLS['us'];
  }

  private async request(path: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<any> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const res = await this.requester({
      url,
      method: options?.method ?? 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: options?.body,
    });

    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status}`);
    }

    const data = await res.json();

    // Handle region mismatch
    if (data?.status === -302 && data?.data?.domains?.api) {
      const domain: string = data.data.domains.api;
      this.region = domain.includes('euc1') ? 'eu' : 'us';
      return this.request(path, options);
    }

    return data;
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web');
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? [];
    return list.filter(r => !r.is_trash);
  }

  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;

    let transcript = '';
    const preDownload: any[] = raw.pre_download_content_list ?? [];
    for (const item of preDownload) {
      const content = item.data_content ?? '';
      if (content.length > transcript.length) transcript = content;
    }

    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript,
    } as PlaudRecordingDetail;
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/user/me');
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? 'unknown',
    };
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken();
    const res = await this.requester({
      url: `${this.baseUrl}/file/download/${id}`,
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch {
      return null;
    }
  }
}
