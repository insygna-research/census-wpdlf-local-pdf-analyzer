import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { sendDropPath } from './helpers';

/**
 * 패키징된 앱(asar) 실행 스모크 — 로컬 전용.
 *
 * 다른 E2E 스펙은 `electron.launch({ args: ['.'] })` 로 **소스 트리의 out/ 를 직접** 실행하므로,
 * 리포지토리의 node_modules 가 그대로 보인다. 즉 "asar 에 어떤 패키지가 들어갔는가"를 전혀
 * 검증하지 못한다 — dependencies 를 devDependencies 로 옮겨 asar 에서 제외해도(인스톨러 크기
 * 축소) 그 스펙들은 무조건 통과한다.
 *
 * 본 스펙은 실제로 패키징된 `win-unpacked` 바이너리를 띄워, asar 안의 번들만으로 renderer 가
 * 동작하는지(React 마운트 + pdfjs worker/cmaps 로 실제 PDF 파싱)를 확인한다. 회귀 대상:
 * renderer 번들이 자립적이지 않게 바뀌거나(외부 bare import 발생) main 이 새 런타임 의존성을
 * dependencies 에 넣지 않은 채 import 하면 여기서 잡힌다.
 *
 * 실행 조건: `npm run package` 또는 electron-builder 로 win-unpacked 이 만들어져 있어야 한다.
 * 없으면 skip (CI 의 기본 E2E 잡은 패키징을 하지 않으므로 자동 skip).
 */

// electron-builder 의 기본 출력 경로만 본다 — 임시 출력 디렉터리를 후보에 넣으면 오래된
// 산출물로 조용히 통과할 수 있다(stale pass). `npm run package` 후 실행할 것.
const EXE_PATH = join(process.cwd(), 'dist', 'win-unpacked', 'PDF 자료 분석기.exe');

function findPackagedExe(): string | null {
  return existsSync(EXE_PATH) ? EXE_PATH : null;
}

/**
 * 파서의 텍스트 하한(공백 제외 50자 미만이면 스캔본으로 보고 OCR fallback → 실패)을 넘도록
 * 충분히 긴 본문을 그린다. 짧은 문장이면 pdfjs 가 정상 동작해도 PDF_NO_TEXT 로 거부되어
 * "번들이 깨진 것"과 구분되지 않는다.
 */
async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  const lines = [
    'Packaged asar smoke test document for the local PDF analyzer.',
    'This paragraph exists so that the extracted text comfortably exceeds',
    'the minimum character threshold used to detect scanned documents.',
  ];
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 720 - i * 24, size: 12, font }));
  return Buffer.from(await pdf.save());
}

const exePath = findPackagedExe();

test.describe('패키징 앱 스모크 (로컬 전용 — win-unpacked 필요)', () => {
  test.skip(exePath === null, 'win-unpacked 빌드가 없어 skip (electron-builder 실행 후 재시도)');
  test.skip(process.platform !== 'win32', 'Windows 패키징 산출물 전용');

  test('asar 번들만으로 기동 + 실제 PDF 파싱 (node_modules 제외 회귀 가드)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'lpa-packaged-'));
    // provider=claude 시드로 첫 실행 셋업 위자드를 우회해 메인 화면으로 진입(smoke.spec 과 동일 계약).
    // 위자드 화면에서는 파일 드롭이 문서 화면으로 전환되지 않는다.
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ provider: 'claude', uiLanguage: 'ko', summaryLanguage: 'ko', theme: 'light' }),
      'utf-8',
    );
    const app = await electron.launch({
      executablePath: exePath!,
      args: [],
      env: {
        ...process.env,
        PDF_ANALYZER_USER_DATA: userDataDir,
        // 실 Ollama 결합 차단 — 죽은 포트로 격리(다른 결정적 스펙과 동일 계약).
        PDF_ANALYZER_OLLAMA_URL: 'http://127.0.0.1:59999',
      },
    });

    try {
      const page = await app.firstWindow();
      const pageErrors: Error[] = [];
      page.on('pageerror', (err) => pageErrors.push(err));

      // 1) renderer 번들이 asar 안에서 마운트되는가 (React + Tailwind + store)
      await expect(page.locator('#root')).toBeVisible({ timeout: 30_000 });

      // 2) pdfjs worker + cmaps 가 asar/asarUnpack 경로에서 로드되어 실제 파싱이 되는가.
      //    file:dropped IPC 로 실제 바이트를 전달(합성 DragEvent 가 아닌 프로덕션 경로).
      const pdfPath = join(userDataDir, 'packaged-smoke.pdf');
      writeFileSync(pdfPath, await makePdf());
      // 드롭 페이로드 구성은 결정적 스펙들과 동일 계약(helpers.sendDropPath)을 재사용한다.
      await sendDropPath(app, pdfPath, readFileSync(pdfPath).toString('base64'));

      // 파싱이 성공하면 문서 화면으로 전환되어 파일명 + 페이지 수가 노출된다.
      await expect(page.getByText('packaged-smoke.pdf (1p)')).toBeVisible({ timeout: 60_000 });

      // 3) 번들 누락은 대개 pageerror(모듈 로드 실패)로 드러난다.
      expect(pageErrors.map((e) => e.message)).toEqual([]);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
