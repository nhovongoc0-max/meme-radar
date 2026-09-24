// Only the explicit confirmation handler may request installation.
// A lost install response is reconciled with GETs, never automatically replayed.
(() => {
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries(['updateButton', 'updateDialog', 'updateVersion', 'updateMessage', 'updateInstall', 'updateClose'].map(id => [id, $(id)]));
  if (Object.values(ui).some(value => !value)) return;
  const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar'];
  const copy = {
    version: ['当前 {current} · 目标 {target}', '目前 {current} · 目標 {target}', 'Current {current} · Target {target}', '現在 {current} · 更新先 {target}', '현재 {current} · 대상 {target}', 'الحالي {current} · المستهدف {target}'],
    unknown: ['待核对', '待核對', 'Not verified', '未確認', '미확인', 'غير متحقق'],
    idle: ['点击重新检查以获取稳定版本。', '點擊重新檢查以取得穩定版本。', 'Check again to find stable releases.', '再確認して安定版を検索します。', '안정 버전을 다시 확인하세요.', 'أعد الفحص للعثور على الإصدارات المستقرة.'],
    checking: ['正在检查稳定版本…', '正在檢查穩定版本…', 'Checking stable releases…', '安定版を確認中…', '안정 버전 확인 중…', 'جارٍ فحص الإصدارات المستقرة…'],
    available: ['发现更新。请确认上方目标版本后，再点击确认更新并重启。', '發現更新。請核對上方目標版本，再確認更新並重新啟動。', 'Update found. Review the target version above, then confirm installation and restart.', '更新があります。上の更新先を確認してから、更新と再起動を承認してください。', '업데이트가 있습니다. 위 대상 버전을 확인한 뒤 설치 및 재시작을 승인하세요.', 'يتوفر تحديث. راجع الإصدار المستهدف أعلاه ثم أكد التثبيت وإعادة التشغيل.'],
    current: ['未发现更高的稳定版本；不会降级或重装当前版本。', '未發現更高的穩定版本；不會降級或重裝目前版本。', 'No newer stable release. The current version will not be downgraded or reinstalled.', '新しい安定版はありません。ダウングレードや同じ版の再インストールはしません。', '더 새로운 안정 버전이 없습니다. 다운그레이드하거나 현재 버전을 재설치하지 않습니다.', 'لا يوجد إصدار مستقر أحدث. لن يتم الرجوع إلى إصدار أقدم أو إعادة تثبيت الحالي.'],
    local: ['本机测试版、源码工作区或未发布修改受保护，不会自动覆盖。请保留当前版本。', '本機測試版、原始碼工作區或未發布修改受保護，不會自動覆蓋。請保留目前版本。', 'Local test builds, source workspaces and unpublished changes are protected from automatic overwrite. Keep this version.', 'ローカルテスト版・ソース作業領域・未公開の変更は自動上書きしません。現在の版を保持してください。', '로컬 테스트 빌드, 소스 작업 공간 및 미공개 변경은 자동 덮어쓰기로부터 보호됩니다. 현재 버전을 유지하세요.', 'النسخ التجريبية المحلية ومساحات المصدر والتغييرات غير المنشورة محمية من الاستبدال التلقائي. احتفظ بهذا الإصدار.'],
    blocked: ['更新条件未通过，当前版本保留。可重新检查。', '更新條件未通過，目前版本保留。可重新檢查。', 'Update checks did not pass. The current version is retained; you can check again.', '更新条件を満たしていません。現在の版を保持します。再確認できます。', '업데이트 조건을 충족하지 못했습니다. 현재 버전을 유지하며 다시 확인할 수 있습니다.', 'لم تنجح شروط التحديث. تم الاحتفاظ بالإصدار الحالي؛ يمكنك إعادة الفحص.'],
    submitting: ['正在提交更新请求；请勿重复操作…', '正在提交更新請求；請勿重複操作…', 'Submitting the update request; do not repeat it…', '更新要求を送信中。繰り返さないでください…', '업데이트 요청 중입니다. 반복하지 마세요…', 'جارٍ إرسال طلب التحديث؛ لا تكرره…'],
    verifying: ['正在下载并校验发布包与当前安装…', '正在下載並校驗發布包與目前安裝…', 'Downloading and verifying the release and current installation…', '配布パッケージと現在のインストールを検証中…', '릴리스 및 현재 설치를 다운로드하고 검증 중…', 'جارٍ تنزيل الإصدار والتحقق منه ومن التثبيت الحالي…'],
    handoff: ['正在交接更新并等待本机服务重启；页面会自动核对状态。', '正在交接更新並等待本機服務重新啟動；頁面會自動核對狀態。', 'Handing off the update and waiting for the local service to restart. This page will verify its status.', '更新を引き継ぎ、ローカルサービスの再起動を待っています。状態を自動確認します。', '업데이트를 인계하고 로컬 서비스 재시작을 기다립니다. 상태를 자동 확인합니다.', 'جارٍ تسليم التحديث وانتظار إعادة تشغيل الخدمة المحلية. ستتحقق الصفحة من حالتها.'],
    recovering: ['安装结果尚未确认，正在核对本机状态；不会重复发送安装请求。', '安裝結果尚未確認，正在核對本機狀態；不會重複發送安裝請求。', 'Installation outcome is unconfirmed. Checking local status without resending installation.', 'インストール結果は未確認です。再送せずローカル状態を確認しています。', '설치 결과가 확인되지 않았습니다. 설치를 재전송하지 않고 로컬 상태를 확인합니다.', 'نتيجة التثبيت غير مؤكدة. جارٍ فحص الحالة المحلية دون إعادة إرسال التثبيت.'],
    health: ['正在核对重启后的服务版本；尚未确认更新完成。', '正在核對重新啟動後的服務版本；尚未確認更新完成。', 'Verifying the restarted service version; completion is not yet confirmed.', '再起動後のサービス版を確認中。更新完了はまだ未確認です。', '재시작된 서비스 버전을 확인 중이며 완료는 아직 확인되지 않았습니다.', 'جارٍ التحقق من إصدار الخدمة بعد إعادة التشغيل؛ لم يتأكد الاكتمال بعد.'],
    complete: ['更新完成，本机服务版本已核对。扫描状态仍以看板为准。', '更新完成，本機服務版本已核對。掃描狀態仍以看板為準。', 'Update complete; the local service version is verified. See the dashboard for scanner status.', '更新完了。ローカルサービスの版を確認しました。スキャン状態は画面で確認してください。', '업데이트 완료. 로컬 서비스 버전을 확인했습니다. 스캔 상태는 대시보드를 확인하세요.', 'اكتمل التحديث وتم التحقق من إصدار الخدمة المحلية. راجع لوحة المعلومات لحالة المسح.'],
    rolled_back: ['更新未完成，已核对恢复后的原版本；本机配置和记录保留。', '更新未完成，已核對恢復後的原版本；本機設定與紀錄保留。', 'The update did not complete. The restored original version is verified; local settings and records are retained.', '更新は完了しませんでした。復旧した元の版を確認しました。ローカル設定と記録は保持されます。', '업데이트가 완료되지 않았습니다. 복원된 원래 버전을 확인했으며 로컬 설정과 기록은 유지됩니다.', 'لم يكتمل التحديث. تم التحقق من استعادة الإصدار الأصلي مع الاحتفاظ بالإعدادات والسجلات المحلية.'],
    rollback_blocked: ['自动恢复未完成。请保留原目录与备份，勿重复安装。', '自動恢復未完成。請保留原目錄與備份，勿重複安裝。', 'Automatic recovery did not complete. Keep the original directory and backup; do not reinstall.', '自動復旧が完了していません。元のディレクトリとバックアップを保持し、再インストールしないでください。', '자동 복구가 완료되지 않았습니다. 원본 폴더와 백업을 보존하고 다시 설치하지 마세요.', 'لم يكتمل الاسترداد التلقائي. احتفظ بالمجلد الأصلي والنسخة الاحتياطية ولا تعاود التثبيت.'],
    network: ['未能取得更新状态，请重试检查；未确认更新完成。', '未能取得更新狀態，請重試檢查；未確認更新完成。', 'Could not read update status. Retry the check; completion is not confirmed.', '更新状態を取得できません。再確認してください。更新完了は未確認です。', '업데이트 상태를 읽지 못했습니다. 다시 확인하세요. 완료는 확인되지 않았습니다.', 'تعذر قراءة حالة التحديث. أعد الفحص؛ لم يتأكد الاكتمال.'],
    check: ['重新检查', '重新檢查', 'Check again', '再確認', '다시 확인', 'إعادة الفحص'],
    status: ['核对更新状态', '核對更新狀態', 'Verify update status', '更新状態を確認', '업데이트 상태 확인', 'التحقق من حالة التحديث'],
    install: ['确认更新并重启', '確認更新並重新啟動', 'Confirm update and restart', '更新して再起動を承認', '업데이트 및 재시작 승인', 'تأكيد التحديث وإعادة التشغيل'],
  };
  const phases = new Set(['idle', 'checking', 'available', 'current', 'blocked', 'verifying', 'handoff', 'complete', 'rolled_back', 'rollback_blocked']);
  const codes = new Set(['UPDATE_NETWORK', 'UPDATE_STORAGE', 'UPDATE_LOCAL', 'UPDATE_CHECKSUM', 'UPDATE_ARCHIVE', 'UPDATE_BUSY', 'UPDATE_VERSION', 'UPDATE_PLATFORM', 'UPDATE_DEPENDENCIES', 'UPDATE_HANDOFF', 'UPDATE_START']);
  const version = value => typeof value === 'string' && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value) ? value : null;
  const newer = (target, current) => {
    if (!version(target) || !version(current)) return false;
    const a = target.split('.').map(Number), b = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let locale = document.documentElement.lang, snapshot = null, busy = '', notice = '', installTarget = null;
  let recovering = false, healthy = false, live = true, generation = 0, pollTimer, requestController, failures = 0;
  const t = (key, values = {}) => copy[key][Math.max(0, locales.indexOf(locale))].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
  const activePhase = () => ['checking', 'verifying', 'handoff'].includes(snapshot?.phase);
  const reconcile = () => recovering || installTarget !== null || activePhase() || (['complete', 'rolled_back'].includes(snapshot?.phase) && !healthy);
  function canInstall() {
    return !busy && !notice && !reconcile() && snapshot?.phase === 'available' && snapshot.code !== 'UPDATE_LOCAL' && snapshot.canInstall
      && newer(snapshot.availableVersion, snapshot.currentVersion);
  }
  function paint() {
    let key = notice || snapshot?.phase || 'idle';
    if (snapshot?.code === 'UPDATE_LOCAL') key = 'local';
    else if (busy === 'install') key = 'submitting';
    else if (['complete', 'rolled_back'].includes(snapshot?.phase) && !healthy) key = 'health';
    else if (recovering && !activePhase()) key = 'recovering';
    ui.updateVersion.textContent = t('version', { current: snapshot?.currentVersion || t('unknown'), target: installTarget || snapshot?.availableVersion || t('unknown') });
    ui.updateMessage.textContent = t(key) + (snapshot?.code ? ' · ' + snapshot.code : '');
    const mode = reconcile() ? 'status' : canInstall() ? 'install' : 'check';
    ui.updateInstall.dataset.mode = mode;
    ui.updateInstall.textContent = t(mode);
    ui.updateInstall.hidden = !snapshot && !notice && !!busy;
    ui.updateInstall.disabled = !!busy;
    ui.updateButton.disabled = busy === 'check' || busy === 'status';
  }
  function stopPoll() { if (pollTimer !== undefined) clearTimeout(pollTimer); pollTimer = undefined; }
  function schedulePoll() {
    stopPoll();
    if (live && reconcile()) pollTimer = setTimeout(() => { pollTimer = undefined; void perform('status'); }, Math.min(15000, 3000 * (1 + failures)));
  }
  async function request(path, body) {
    const controller = new AbortController(); requestController = controller;
    let deadline;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
            ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
          return { ok: response.ok, body: await response.json() };
        })(),
        new Promise((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new Error('update_timeout')); }, path.endsWith('install') ? 25000 : path.endsWith('check') ? 20000 : 8000); }),
      ]);
    } finally { clearTimeout(deadline); if (requestController === controller) requestController = null; }
  }
  function accept(result) {
    const value = result?.body?.update;
    if (!value || !phases.has(value.phase)) throw new Error('update_invalid');
    snapshot = { phase: value.phase, code: codes.has(value.code) ? value.code : null, currentVersion: version(value.currentVersion), availableVersion: version(value.availableVersion), canInstall: value.canInstall === true };
    if (snapshot.phase === 'available' && !newer(snapshot.availableVersion, snapshot.currentVersion)) {
      snapshot.phase = snapshot.currentVersion && snapshot.availableVersion ? 'current' : 'blocked';
      if (snapshot.phase === 'blocked' && snapshot.code !== 'UPDATE_LOCAL') snapshot.code = 'UPDATE_VERSION';
      snapshot.availableVersion = null; snapshot.canInstall = false;
    } else if (snapshot.phase === 'available' && !snapshot.canInstall) snapshot.phase = 'blocked';
    healthy = false;
    if (['blocked', 'rolled_back', 'rollback_blocked'].includes(snapshot.phase) || snapshot.code === 'UPDATE_LOCAL') { installTarget = null; recovering = false; }
    if (!result.ok && !['blocked', 'verifying', 'handoff', 'rollback_blocked'].includes(snapshot.phase)) throw new Error('update_failed');
  }
  async function verifyHealth(valid) {
    if (!['complete', 'rolled_back'].includes(snapshot?.phase)) return;
    const expected = snapshot.currentVersion, target = installTarget || snapshot.availableVersion;
    if (!expected || snapshot.phase === 'complete' && (!target || expected !== target)) throw new Error('update_version_unverified');
    const result = await request('/health');
    if (!valid()) return;
    const value = result.body;
    if (!result.ok || value?.ok !== true || value.service !== 'meme-radar' || value.execution !== false || version(value.version) !== expected) throw new Error('update_health_unverified');
    healthy = true; installTarget = null; recovering = false;
  }
  async function readStatus(valid) {
    const result = await request('/api/update-status');
    if (!valid()) return;
    accept(result); await verifyHealth(valid);
  }
  async function perform(kind) {
    if (busy || !live) return;
    if (kind === 'install' && !canInstall()) return;
    const target = kind === 'install' ? snapshot.availableVersion : null, started = generation;
    const valid = () => live && generation === started;
    busy = kind; notice = kind === 'check' ? 'checking' : ''; stopPoll();
    if (kind === 'install') { installTarget = target; recovering = true; }
    paint();
    try {
      if (kind === 'install') {
        const result = await request('/api/update-install', { version: target, confirm: 'INSTALL_UPDATE' });
        if (!valid()) return;
        accept(result); await verifyHealth(valid);
      } else {
        // Also catches an update started in another tab before a new check.
        await readStatus(valid);
        if (!valid()) return;
        if (kind === 'check' && !reconcile() && snapshot.phase !== 'rollback_blocked') {
          const result = await request('/api/update-check', {});
          if (!valid()) return;
          accept(result); await verifyHealth(valid);
        }
      }
      if (!valid()) return;
      notice = ''; failures = 0;
    } catch {
      if (!valid()) return;
      notice = reconcile() || kind === 'install' ? 'recovering' : 'network'; failures++;
    } finally {
      if (valid()) { busy = ''; paint(); schedulePoll(); }
    }
  }
  ui.updateButton.addEventListener('click', () => {
    if (!ui.updateDialog.open) ui.updateDialog.showModal();
    paint(); void perform(reconcile() ? 'status' : 'check');
  });
  ui.updateInstall.addEventListener('click', () => {
    if (busy) return;
    const mode = ui.updateInstall.dataset.mode;
    // The displayed version, not a subsequently fetched target, is confirmed.
    if (mode === 'install') { if (canInstall()) void perform('install'); }
    else void perform(reconcile() ? 'status' : 'check');
  });
  ui.updateClose.addEventListener('click', () => ui.updateDialog.close());
  window.addEventListener('radar-locale', event => { locale = event.detail; paint(); });
  window.addEventListener('pagehide', () => { live = false; generation++; stopPoll(); requestController?.abort(); busy = ''; });
  window.addEventListener('pageshow', event => { if (event.persisted) { live = true; generation++; void perform('status'); } });
  paint(); void perform('status'); // Read-only boot: never check releases or install automatically.
})();
