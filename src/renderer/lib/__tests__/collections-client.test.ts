import { describe, it, expect, vi, beforeEach } from 'vitest';

// multi-doc Phase 3 module-1: collections-client (렌더러 IPC 래퍼) best-effort 계약.
// 모든 호출은 실패해도 throw 하지 않고 안전 기본값으로 수렴한다.

const api = {
  list: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
vi.stubGlobal('window', { electronAPI: { collections: api } });

import { listCollections, saveCollection, deleteCollection } from '../collections-client';

beforeEach(() => vi.clearAllMocks());

describe('collections-client', () => {
  it('list: IPC 결과 전달', async () => {
    api.list.mockResolvedValue([{ id: '1', name: 'x', docHashes: ['a'], createdAt: 'x', lastAccessed: 'x' }]);
    const r = await listCollections();
    expect(r).toHaveLength(1);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // QA23(D-LOW): 실패를 빈 배열로 수렴시키면 UI 가 "저장된 컬렉션이 없습니다" 를 **단정적으로**
  // 표시해 사용자가 전량 소실로 읽는다(collections.json 은 유일 사본). null 로 구분한다.
  it('list: 실패 시 null (빈 배열=정말 없음 과 구분, throw 안 함)', async () => {
    api.list.mockRejectedValue(new Error('ipc'));
    expect(await listCollections()).toBeNull();
  });

  it('list: 정말 비어 있으면 빈 배열', async () => {
    api.list.mockResolvedValue([]);
    expect(await listCollections()).toEqual([]);
  });

  it('save: 입력 전달 + 결과 반환', async () => {
    api.save.mockResolvedValue({ ok: true, id: 'new' });
    const r = await saveCollection({ name: '묶음', docHashes: ['a'.repeat(64)] });
    expect(r).toEqual({ ok: true, id: 'new' });
    expect(api.save).toHaveBeenCalledWith({ name: '묶음', docHashes: ['a'.repeat(64)] });
  });

  it('save: 실패 시 ok:false', async () => {
    api.save.mockRejectedValue(new Error('ipc'));
    expect(await saveCollection({ name: 'x', docHashes: ['a'] })).toEqual({ ok: false });
  });

  it('delete: 위임 + 실패 시 ok:false', async () => {
    api.delete.mockResolvedValue({ ok: true });
    expect(await deleteCollection('id1')).toEqual({ ok: true });
    api.delete.mockRejectedValue(new Error('ipc'));
    expect(await deleteCollection('id1')).toEqual({ ok: false });
  });
});
