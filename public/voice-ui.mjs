import { VoiceAlerts, VOICE_TTL, voiceKey, voiceEligible } from './voice-alerts.mjs';
import { createVoicePlayer } from './voice-player.mjs';

const $ = id => document.getElementById(id);
const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar'];
const copy = {
  title: ['候选语音提醒','候選語音提醒','Candidate voice alerts','候補の音声通知','후보 음성 알림','تنبيهات المرشحين الصوتية'],
  enable: ['试听并开启','試聽並開啟','Preview & enable','試聴して有効化','미리 듣기 및 켜기','استماع وتفعيل'],
  preview: ['试听','試聽','Preview','試聴','미리 듣기','استماع'],
  stop: ['关闭','關閉','Turn off','オフ','끄기','إيقاف'],
  language: ['播报语言','播報語言','Alert language','通知言語','알림 언어','لغة التنبيه'],
  volume: ['音量','音量','Volume','音量','음량','مستوى الصوت'],
  help: ['保持页面打开，播报代币自动置顶。','保持頁面開啟，播報代幣自動置頂。','Keep this page open. Announced tokens are pinned first.','ページを開いたままに。通知銘柄は先頭に表示。','페이지를 열어 두세요. 알림 토큰이 맨 위에 표시됩니다.','أبقِ الصفحة مفتوحة؛ تثبّت الرموز المعلنة في الأعلى.'],
  off: ['未开启','未開啟','Off','オフ','꺼짐','متوقف'],
  click: ['点击启用声音','點擊啟用聲音','Click to allow audio','クリックして音声を許可','클릭하여 소리 허용','انقر للسماح بالصوت'],
  ready: ['已开启 · 仅提醒新候选','已開啟 · 僅提醒新候選','On · new candidates only','オン・新しい候補のみ','켜짐 · 새 후보만','مفعّل · المرشحون الجدد فقط'],
  loading: ['正在准备语音…','正在準備語音…','Preparing audio…','音声を準備中…','음성 준비 중…','جارٍ تجهيز الصوت…'],
  error: ['声音未就绪，点击重试','聲音未就緒，點擊重試','Audio not ready; click to retry','音声未準備・クリックして再試行','소리 준비 안 됨; 클릭하여 재시도','الصوت غير جاهز؛ انقر لإعادة المحاولة'],
  noVoice: ['所选语言的本机语音未就绪，请重试或在系统中安装','所選語言的本機語音未就緒，請重試或在系統中安裝','The selected local voice is unavailable; retry or install it on this device','選択した言語のローカル音声がありません。再試行または端末に追加してください','선택한 언어의 로컬 음성이 없습니다. 다시 시도하거나 기기에 설치하세요','صوت اللغة المحددة غير متاح محليًا؛ أعد المحاولة أو ثبته على هذا الجهاز'],
  offline: ['连接中断，提醒暂停','連線中斷，提醒暫停','Offline · alerts paused','接続切断・通知停止','연결 끊김 · 알림 일시 중지','الاتصال منقطع · التنبيهات متوقفة'],
  muted: ['音量为0，提醒暂停','音量為0，提醒暫停','Muted · alerts paused','音量0・通知停止','음량 0 · 알림 일시 중지','الصوت مكتوم · التنبيهات متوقفة'],
  unsupported: ['请使用新版浏览器并允许本地存储','請使用新版瀏覽器並允許本機儲存','Use a modern browser with local storage enabled','最新ブラウザーでローカル保存を許可してください','최신 브라우저에서 로컬 저장소를 허용하세요','استخدم متصفحًا حديثًا مع السماح بالتخزين المحلي']
};
const prefsKey = 'memeCommunityVoiceV1', historyKey = 'memeCommunityVoiceHistoryV1';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { localStorage.setItem(key, JSON.stringify(value)); };
let locale = read('memeRadarLanguageV1', 'zh-CN');
let prefs = read(prefsKey, {}), enabled = false, online = false, snapshot = null, epoch = 0, busy = false;
let voiceLanguage = prefs.language === 'en' ? 'en' : 'zh';
let state = prefs.enabled ? 'click' : 'off';
let alertSequence = 0;
const tracker = new VoiceAlerts(), player = createVoicePlayer();
const volume = Number(prefs.volume);
$('voiceVolume').value = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 50;
$('voiceLanguage').value = voiceLanguage;
const t = key => copy[key][Math.max(0, locales.indexOf(locale))];
const ignored = row => {
  const marks = read('robinhoodRadarManualMarksV1', {});
  const key = voiceKey(row), address = key.slice(key.indexOf(':') + 1);
  return (marks[key] || (row.chain === 'robinhood' ? marks[address] : null))?.decision === 'ignored';
};
function paint() {
  $('voiceTitle').textContent = t('title'); $('voiceHelp').textContent = t('help');
  $('voiceEnable').textContent = t(enabled ? 'preview' : 'enable');
  $('voiceStop').textContent = t('stop'); $('voiceStop').hidden = !enabled && state !== 'loading';
  $('voiceLanguageLabel').textContent = t('language'); $('voiceLanguage').setAttribute('aria-label', t('language'));
  $('voiceVolumeLabel').textContent = t('volume'); $('voiceVolume').setAttribute('aria-label', t('volume'));
  $('voiceStatus').textContent = t(state);
}
function savePrefs() { prefs = { enabled, volume: Number($('voiceVolume').value), language: voiceLanguage }; write(prefsKey, prefs); }
async function notify() {
  if (!enabled || !online || busy) return;
  if (!player.ready) { state = 'click'; paint(); return; }
  if (Number($('voiceVolume').value) === 0) { state = 'muted'; paint(); return; }
  busy = true;
  const started = epoch;
  try {
    await navigator.locks.request('meme-community-voice', { ifAvailable: true }, async lock => {
      if (!lock || started !== epoch || !enabled || !online || Number($('voiceVolume').value) === 0) return;
      const now = Date.now(), saved = read(historyKey, {});
      const notified = Object.fromEntries(Object.entries(saved.notified || {}).filter(([, at]) => Number.isFinite(at) && now - at < VOICE_TTL));
      const batch = tracker.batch(notified, now, ignored);
      if (!batch.length || now - (saved.lastAt || 0) < 60_000) return;
      let played = false, announcement = null, announcedRows = [];
      try {
        played = await player.play(Number($('voiceVolume').value) / 100, { language: voiceLanguage, onStart() {
          if (started !== epoch || !enabled || !online || Number($('voiceVolume').value) === 0) return false;
          const at = Date.now();
          // Speech may have waited in the browser queue. Recheck the latest
          // snapshot before displaying or acknowledging this actual playback.
          announcedRows = batch.flatMap(row => {
            const current = snapshot?.chains?.[row.chain]?.find(item => item && item.chain === row.chain && typeof item.address === 'string' && voiceKey(item) === voiceKey(row));
            return current && voiceEligible(current, at) && !ignored(current) ? [current] : [];
          });
          if (!announcedRows.length) return false;
          // The alert has been delivered once native speech actually starts.
          // Record it now, not on completion: switching tabs, muting, or an OS
          // interruption must not replay the same contract on the next poll.
          for (const row of announcedRows) notified[voiceKey(row)] = at;
          write(historyKey, { notified, lastAt: at });
          tracker.acknowledge(announcedRows, at);
          announcement = { id: ++alertSequence, startedAt: at, rows: announcedRows.map(row => ({
            source: row.source === 'live' ? 'live' : 'audit', chain: row.chain, address: row.address,
            auditedAt: row.auditedAt, staleAt: row.staleAt
          })) };
          window.dispatchEvent(new CustomEvent('radar-voice-start', { detail: announcement }));
          return true;
        } });
      } finally {
        if (announcement) window.dispatchEvent(new CustomEvent('radar-voice-finish', { detail: { id: announcement.id, completed: played } }));
      }
    });
    if (enabled && started === epoch) { state = Number($('voiceVolume').value) === 0 ? 'muted' : online ? 'ready' : 'offline'; paint(); }
  } catch {
    if (started === epoch) {
      ++epoch; enabled = false; player.stop(); tracker.reset(); state = 'error'; paint();
      try { savePrefs(); } catch {}
    }
  }
  finally { busy = false; }
}
$('voiceEnable').addEventListener('click', async () => {
  if (player.playing || state === 'loading') return;
  const started = ++epoch;
  if (!enabled) { tracker.reset(); if (snapshot) tracker.ingest(snapshot, Date.now(), ignored); }
  state = 'loading'; paint();
  try {
    // Both voice selection and speak() stay before the first await so strict
    // in-app browsers still see the original user gesture.
    player.unlock(voiceLanguage);
    if (!navigator.locks?.request) throw new Error('browser_unsupported');
    const volume = Number($('voiceVolume').value) / 100;
    if (!(volume > 0)) {
      enabled = false; state = 'muted'; try { savePrefs(); } catch {} paint(); return;
    }
    const preview = player.play(volume, { language: voiceLanguage, onStart() {
      if (started !== epoch) return false;
      enabled = true; savePrefs(); state = online ? 'ready' : 'offline'; paint();
      return true;
    } }); // Preview does not consume candidates.
    const played = await preview;
    if (started !== epoch) return;
    if (!played || !enabled) throw new Error('speech_did_not_start');
    Promise.resolve().then(() => notify());
  } catch (error) { if (started === epoch) {
    enabled = false; state = /^(?:chinese|english)_voice_missing$/.test(error.message) ? 'noVoice' : navigator.locks?.request ? 'error' : 'unsupported';
    try { savePrefs(); } catch {} paint();
  } }
});
$('voiceStop').addEventListener('click', () => {
  ++epoch; enabled = false; tracker.reset(); player.stop(); state = 'off';
  try { savePrefs(); } catch {} paint();
});
$('voiceVolume').addEventListener('input', () => {
  ++epoch; tracker.reset(); if (snapshot) tracker.ingest(snapshot, Date.now(), ignored);
  player.stop(); state = enabled ? (Number($('voiceVolume').value) ? (online ? 'ready' : 'offline') : 'muted') : 'off';
  try { savePrefs(); } catch {} paint();
});
$('voiceLanguage').addEventListener('change', async () => {
  const next = $('voiceLanguage').value === 'en' ? 'en' : 'zh';
  if (next === voiceLanguage) return;
  const started = ++epoch; voiceLanguage = next; player.stop();
  try { savePrefs(); } catch {}
  if (!enabled) { state = 'off'; paint(); return; }
  state = 'loading'; paint();
  try {
    player.unlock(voiceLanguage);
    const volume = Number($('voiceVolume').value) / 100;
    if (!(volume > 0)) { state = 'muted'; savePrefs(); paint(); return; }
    const preview = player.play(volume, { language: voiceLanguage, onStart() {
      if (started !== epoch) return false;
      state = online ? 'ready' : 'offline'; savePrefs(); paint(); return true;
    } });
    const played = await preview;
    if (started !== epoch) return;
    if (!played) throw new Error('speech_did_not_start');
    if (started === epoch) Promise.resolve().then(() => notify());
  } catch (error) {
    if (started === epoch) {
      enabled = false; state = /^(?:chinese|english)_voice_missing$/.test(error.message) ? 'noVoice' : 'error';
      try { savePrefs(); } catch {} paint();
    }
  }
});
window.addEventListener('radar-snapshot', event => {
  if (!event.detail?.chains) return;
  snapshot = event.detail; online = true;
  if (enabled) {
    if (Number($('voiceVolume').value) === 0) tracker.reset();
    tracker.ingest(snapshot, Date.now(), ignored); void notify();
  }
});
window.addEventListener('storage', event => {
  if (event.key !== prefsKey) return;
  const incoming = read(prefsKey, {});
  ++epoch; player.stop(); tracker.reset(); if (snapshot) tracker.ingest(snapshot, Date.now(), ignored);
  if (Number.isFinite(incoming.volume)) $('voiceVolume').value = Math.max(0, Math.min(100, incoming.volume));
  const incomingLanguage = incoming.language === 'en' ? 'en' : 'zh';
  if (incomingLanguage !== voiceLanguage) { voiceLanguage = incomingLanguage; $('voiceLanguage').value = voiceLanguage; enabled = false; state = incoming.enabled ? 'click' : 'off'; }
  else if (!incoming.enabled) { enabled = false; state = 'off'; }
  else state = enabled ? (Number($('voiceVolume').value) === 0 ? 'muted' : online ? 'ready' : 'offline') : 'click';
  paint(); // Another tab can silence this one, but cannot unlock its browser audio.
});
window.addEventListener('radar-offline', () => {
  online = false; snapshot = null; ++epoch; tracker.reset(); player.stop();
  if (enabled) state = 'offline'; paint();
});
window.addEventListener('radar-locale', event => { locale = event.detail; paint(); });
window.addEventListener('pagehide', () => { ++epoch; enabled = false; tracker.reset(); player.stop(); state = 'click'; paint(); });
window.addEventListener('pageshow', event => { if (event.persisted) { snapshot = null; online = false; state = 'click'; paint(); } });
paint();
