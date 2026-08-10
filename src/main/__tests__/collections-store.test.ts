import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COLLECTION_MAX_COUNT, type CollectionStoreFile } from '../../shared/collection-types';

// multi-doc Phase 3 module-1 (L1): collections-store 파일 I/O·검증·LRU.
// fs/promises 를 in-memory 가상 FS 로 모킹해 원자적 쓰기·정규화·LRU·삭제를 행위 검증.

const V = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs/promises', () => {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const enoent = () => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; return e; };
  return {
    default: {
      writeFile: vi.fn(async (p: string, data: string) => { V.files.set(norm(p), String(data)); }),
      rename: vi.fn(async (a: string, b: string) => {
        const k = norm(a); const v = V.files.get(k);
        if (v === undefined) throw enoent();
        V.files.set(norm(b), v); V.files.delete(k);
      }),
      readFile: vi.fn(async (p: string) => {
        const v = V.files.get(norm(p));
        if (v === undefined) throw enoent();
        return v;
      }),
      unlink: vi.fn(async (p: string) => { V.files.delete(norm(p)); }),
    },
  };
});

import { listCollections, saveCollection, deleteCollection, touchCollection } from '../collections-store';

const FILE = '/tmp/collections.json';
const H = (c: string) => c.repeat(64); // 유효 docHash 헬퍼 (hex 64자)
const T0 = Date.parse('2026-06-15T00:00:00.000Z');

function readFile(): CollectionStoreFile {
  return JSON.parse(V.files.get(FILE) as string) as CollectionStoreFile;
}

beforeEach(() => { V.files.clear(); });

describe('listCollections', () => {
  it('파일 없으면 빈 배열(ENOENT fail-safe)', async () => {
    expect(await listCollections(FILE)).toEqual([]);
  });

  it('lastAccessed 내림차순 정렬', async () => {
    await saveCollection(FILE, { name: 'A', docHashes: [H('a')] }, T0);
    await saveCollection(FILE, { name: 'B', docHashes: [H('b')] }, T0 + 1000);
    const list = await listCollections(FILE);
    expect(list.map((c) => c.name)).toEqual(['B', 'A']); // 최근(B) 먼저
  });

  it('손상 항목(멤버 없음/비배열)은 폐기, 유효 항목만 반환', async () => {
    const corrupt: CollectionStoreFile = {
      schemaVersion: 1,
      collections: [
        { id: '1', name: 'valid', docHashes: [H('a')], createdAt: 'x', lastAccessed: 'x' },
        { id: '2', name: 'no-members', docHashes: [], createdAt: 'x', lastAccessed: 'x' },
        { id: '3', name: 'bad-hash', docHashes: ['not-a-hash'], createdAt: 'x', lastAccessed: 'x' },
      ],
    };
    V.files.set(FILE, JSON.stringify(corrupt));
    const list = await listCollections(FILE);
    expect(list.map((c) => c.name)).toEqual(['valid']);
  });
});

describe('saveCollection', () => {
  it('신규 저장 → id 발급 + 멤버/이름 보존', async () => {
    const r = await saveCollection(FILE, { name: '강의 묶음', docHashes: [H('a'), H('b')] }, T0);
    expect(r.ok).toBe(true);
    expect(typeof r.id).toBe('string');
    const list = await listCollections(FILE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '강의 묶음', docHashes: [H('a'), H('b')] });
  });

  it('id 지정 시 upsert(갱신) — 중복 생성 안 함', async () => {
    const r1 = await saveCollection(FILE, { name: 'v1', docHashes: [H('a')] }, T0);
    const r2 = await saveCollection(FILE, { id: r1.id, name: 'v2', docHashes: [H('a'), H('c')] }, T0 + 1000);
    expect(r2.ok).toBe(true);
    const list = await listCollections(FILE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: r1.id, name: 'v2', docHashes: [H('a'), H('c')] });
  });

  it('멤버 docHash 중복 제거 + 무효 hash 필터', async () => {
    await saveCollection(FILE, { name: 'x', docHashes: [H('a'), H('a'), 'bad', H('b')] }, T0);
    const list = await listCollections(FILE);
    expect(list[0]?.docHashes).toEqual([H('a'), H('b')]);
  });

  it('빈 멤버/빈 이름은 거부 (ok:false)', async () => {
    expect(await saveCollection(FILE, { name: '', docHashes: [H('a')] }, T0)).toEqual({ ok: false });
    expect(await saveCollection(FILE, { name: 'x', docHashes: [] }, T0)).toEqual({ ok: false });
    expect(await saveCollection(FILE, { name: 'x', docHashes: ['bad'] }, T0)).toEqual({ ok: false });
  });

  it('개수 상한 초과 시 가장 오래된 것부터 제거(LRU)', async () => {
    // 유효 hex 64자(인덱스를 2-hex 로 32회 반복) — 각기 다른 docHash + 증가하는 시각
    const hashFor = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
    for (let i = 0; i < COLLECTION_MAX_COUNT + 5; i++) {
      await saveCollection(FILE, { name: `c${i}`, docHashes: [hashFor(i)] }, T0 + i * 1000);
    }
    const file = readFile();
    expect(file.collections.length).toBe(COLLECTION_MAX_COUNT);
    // 가장 오래된 c0 은 제거됨
    expect(file.collections.some((c) => c.name === 'c0')).toBe(false);
  });

  // QA23(D-MED): 축출이 **완전 무음**이었다 — 세션 LRU 는 QA21 에서 evicted 이름을 반환해
  // 고지하게 했는데 컬렉션만 빠져 있었다. 저장된 컬렉션이 조용히 사라지면 회수 경로가 없다.
  it('축출된 컬렉션 이름을 반환한다 (무음 소멸 방지)', async () => {
    const hashFor = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
    for (let i = 0; i < COLLECTION_MAX_COUNT; i++) {
      await saveCollection(FILE, { name: `c${i}`, docHashes: [hashFor(i)] }, T0 + i * 1000);
    }
    // 상한을 넘기는 한 건 추가 → 가장 오래된 c0 이 축출된다.
    const r = await saveCollection(FILE, { name: 'new', docHashes: [hashFor(90)] }, T0 + 999_000);
    expect(r.ok).toBe(true);
    expect(r.evicted).toEqual(['c0']);
  });

  it('축출이 없으면 evicted 를 싣지 않는다 (과잉 통지 방지)', async () => {
    const r = await saveCollection(FILE, { name: 'only', docHashes: [H('a')] }, T0);
    expect(r.ok).toBe(true);
    expect(r.evicted).toBeUndefined();
  });

  it('R47: 동률 lastAccessed 에서도 방금 저장한 항목은 evict 되지 않음', async () => {
    const hashFor = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
    // 상한까지 모두 같은 시각(T0)으로 채움
    for (let i = 0; i < COLLECTION_MAX_COUNT; i++) {
      await saveCollection(FILE, { name: `c${i}`, docHashes: [hashFor(i)] }, T0);
    }
    // 상한 초과 신규 항목을 같은 시각(T0)으로 추가 — 동률
    const r = await saveCollection(FILE, { name: 'newest', docHashes: [hashFor(99)] }, T0);
    expect(r.ok).toBe(true);
    const file = readFile();
    expect(file.collections.length).toBe(COLLECTION_MAX_COUNT);
    // 동률이어도 방금 저장한 newest 는 살아있어야 함(ok:true 인데 디스크엔 없는 문제 차단)
    expect(file.collections.some((c) => c.id === r.id && c.name === 'newest')).toBe(true);
  });
});

// lastAccessed 는 목록 정렬 키인 **동시에 LRU 축출 키**인데, 갱신 지점이 saveCollection 하나뿐이라
// 순서가 "최근 연 순" 이 아니라 "최근 편집한 순" 이었다(세션은 load 시 touchSession 으로 갱신 —
// 형제 스토어 중 여기만 빠져 있었다). 매일 열지만 멤버를 바꾸지 않는 컬렉션이 상한에서 먼저
// 축출되고, collections.json 은 유일 사본이라 회수 경로가 없다.
describe('touchCollection', () => {
  it('편집 없이 열기만으로 목록 최상단이 된다', async () => {
    const a = await saveCollection(FILE, { name: 'A', docHashes: [H('a')] }, T0);
    await saveCollection(FILE, { name: 'B', docHashes: [H('b')] }, T0 + 1000);
    expect((await listCollections(FILE)).map((c) => c.name)).toEqual(['B', 'A']);

    expect(await touchCollection(FILE, a.id!, T0 + 2000)).toEqual({ ok: true });
    expect((await listCollections(FILE)).map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('멤버·이름·createdAt 은 건드리지 않는다 (lastAccessed 만 갱신)', async () => {
    const r = await saveCollection(FILE, { name: '원본', docHashes: [H('a'), H('b')] }, T0);
    const before = readFile().collections[0]!;
    await touchCollection(FILE, r.id!, T0 + 5000);
    const after = readFile().collections[0]!;
    expect(after).toEqual({ ...before, lastAccessed: new Date(T0 + 5000).toISOString() });
  });

  it('touch 한 컬렉션은 상한 초과 축출에서 살아남는다 (이 수정의 본래 목적)', async () => {
    const hashFor = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
    const oldest = await saveCollection(FILE, { name: 'daily', docHashes: [hashFor(0)] }, T0);
    for (let i = 1; i < COLLECTION_MAX_COUNT; i++) {
      await saveCollection(FILE, { name: `c${i}`, docHashes: [hashFor(i)] }, T0 + i * 1000);
    }
    // 편집은 하지 않고 열기만 한 상태 — 가장 최근 사용이 된다.
    await touchCollection(FILE, oldest.id!, T0 + 500_000);
    // 상한을 넘기는 신규 저장 → 축출 대상은 daily 가 아니라 그 다음으로 오래된 c1 이어야 한다.
    const r = await saveCollection(FILE, { name: 'new', docHashes: [hashFor(90)] }, T0 + 600_000);
    expect(r.evicted).toEqual(['c1']);
    expect(readFile().collections.some((c) => c.name === 'daily')).toBe(true);
  });

  it('없는 id 는 ok:false + 디스크를 다시 쓰지 않는다', async () => {
    await saveCollection(FILE, { name: 'x', docHashes: [H('a')] }, T0);
    const before = V.files.get(FILE);
    expect(await touchCollection(FILE, 'nonexistent', T0 + 1000)).toEqual({ ok: false });
    expect(V.files.get(FILE)).toBe(before);
  });

  it('빈/비문자열 id 는 거부', async () => {
    expect(await touchCollection(FILE, '', T0)).toEqual({ ok: false });
    expect(await touchCollection(FILE, null, T0)).toEqual({ ok: false });
  });

  it('일시 I/O 오류면 ok:false + 디스크 보존 (전량 소실 금지)', async () => {
    const r = await saveCollection(FILE, { name: 'keep', docHashes: [H('a')] }, T0);
    const before = readFile();
    const fsp = (await import('fs/promises')).default;
    const ebusy = new Error('EBUSY') as NodeJS.ErrnoException;
    ebusy.code = 'EBUSY';
    (fsp.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(ebusy);

    expect(await touchCollection(FILE, r.id!, T0 + 1000)).toEqual({ ok: false });
    expect(readFile()).toEqual(before);
  });
});

describe('deleteCollection', () => {
  it('id 로 삭제', async () => {
    const r = await saveCollection(FILE, { name: 'x', docHashes: [H('a')] }, T0);
    expect((await deleteCollection(FILE, r.id!)).ok).toBe(true);
    expect(await listCollections(FILE)).toEqual([]);
  });

  it('없는 id 도 ok (idempotent)', async () => {
    await saveCollection(FILE, { name: 'x', docHashes: [H('a')] }, T0);
    expect((await deleteCollection(FILE, 'nonexistent')).ok).toBe(true);
    expect(await listCollections(FILE)).toHaveLength(1);
  });

  it('빈 id 는 거부', async () => {
    expect(await deleteCollection(FILE, '')).toEqual({ ok: false });
  });
});

// QA22(C-MED, 데이터손실): QA21 이 세션 manifest 에 대해 고친 "부재 ≠ 일시 I/O 오류" 원칙이
// **형제 스토어인 collections-store 에는 이식되지 않았다**. 흡수형 loadFile 이 RMW 의 read 쪽에
// 쓰이면 EBUSY 한 번에 저장된 컬렉션이 전량 소실되고, 세션과 달리 **회수 경로가 없다**
// (collections.json 이 유일한 사본 — 부팅 reconcile 같은 것이 없다).
describe('일시 I/O 오류 시 디스크 보존 (QA22)', () => {
  const ebusy = () => { const e = new Error('EBUSY') as NodeJS.ErrnoException; e.code = 'EBUSY'; return e; };

  it('저장 중 읽기가 EBUSY 면 기존 컬렉션을 덮어쓰지 않고 실패한다', async () => {
    await saveCollection(FILE, { name: 'keep-1', docHashes: [H('a')] }, T0);
    await saveCollection(FILE, { name: 'keep-2', docHashes: [H('b')] }, T0);
    const before = readFile();

    const fsp = (await import('fs/promises')).default;
    (fsp.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(ebusy());
    const r = await saveCollection(FILE, { name: 'new', docHashes: [H('c')] }, T0);

    expect(r.ok, '일시 오류는 실패로 귀결돼야 한다(무음 성공 금지)').toBe(false);
    expect(readFile(), '디스크가 보존돼야 한다').toEqual(before);
    expect(await listCollections(FILE)).toHaveLength(2);
  });

  it('삭제 중 읽기가 EBUSY 면 파일을 비우지 않는다 (가장 파괴적인 경로)', async () => {
    await saveCollection(FILE, { name: 'keep-1', docHashes: [H('a')] }, T0);
    const r2 = await saveCollection(FILE, { name: 'keep-2', docHashes: [H('b')] }, T0);
    const before = readFile();

    const fsp = (await import('fs/promises')).default;
    (fsp.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(ebusy());
    const r = await deleteCollection(FILE, r2.id!);

    expect(r.ok).toBe(false);
    expect(readFile(), 'filter([]) → saveFile([]) 로 통째 비워지면 안 된다').toEqual(before);
    expect(await listCollections(FILE)).toHaveLength(2);
  });

  it('부재(ENOENT)는 종전대로 흡수 — 첫 저장이 정상 진행된다', async () => {
    const r = await saveCollection(FILE, { name: 'first', docHashes: [H('a')] }, T0);
    expect(r.ok).toBe(true);
    expect(await listCollections(FILE)).toHaveLength(1);
  });

  it('손상 JSON 은 종전대로 흡수 — 재생성으로 자가치유', async () => {
    V.files.set(FILE, '{ broken json');
    const r = await saveCollection(FILE, { name: 'heal', docHashes: [H('a')] }, T0);
    expect(r.ok).toBe(true);
    expect(await listCollections(FILE)).toHaveLength(1);
  });
});
