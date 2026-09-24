export const CANDIDATE_PHRASES = Object.freeze({
  zh: '亲爱的老板～我找到一枚不错的币，快来看看',
  en: 'A new meme candidate was found. Take a look.'
});
export const CANDIDATE_PHRASE = CANDIDATE_PHRASES.zh;
export const normalizeVoiceLanguage = language => language === 'en' ? 'en' : 'zh';

// Use voices installed on the listener's device; never redistribute a system recording.
export function selectChineseVoice(voices = []) {
  const female = /Meijia|Ting.?Ting|Xiaoxiao|Xiaoyi|Huihui|Yaoyao|Hanhan|Yating|Lili|Sinji|美佳|婷婷|晓晓|晓伊|慧慧|瑶瑶/i;
  const score = v => (female.test(v.name) ? 10 : 0) + (/^zh[-_](CN|Hans)/i.test(v.lang) ? 2 : 0) + (v.default ? 1 : 0);
  return voices.filter(v => v.localService === true && /^zh(?:[-_]|$)/i.test(v.lang))
    .sort((a, b) => score(b) - score(a))[0] || null;
}

export function selectEnglishVoice(voices = []) {
  const female = /Samantha|Ava|Victoria|Karen|Moira|Tessa|Zira|Aria|Jenny|Susan|Hazel|Serena/i;
  const score = v => (female.test(v.name) ? 10 : 0) + (/^en[-_](US|GB)/i.test(v.lang) ? 2 : 0) + (v.default ? 1 : 0);
  return voices.filter(v => v.localService === true && /^en(?:[-_]|$)/i.test(v.lang))
    .sort((a, b) => score(b) - score(a))[0] || null;
}

export function selectVoice(voices = [], language = 'zh') {
  return normalizeVoiceLanguage(language) === 'en' ? selectEnglishVoice(voices) : selectChineseVoice(voices);
}

export function createVoicePlayer({ synthesis = globalThis.speechSynthesis,
  makeUtterance = text => new globalThis.SpeechSynthesisUtterance(text),
  schedule = setTimeout, cancelTimer = clearTimeout } = {}) {
  let voice, language = 'zh', unlocked = false, active = null;
  try { synthesis?.getVoices(); } catch {} // Start asynchronous browser voice discovery before the click.
  return {
    get ready() { return unlocked && !!voice; },
    get playing() { return active !== null; },
    get language() { return language; },
    unlock(nextLanguage = 'zh') {
      unlocked = false;
      if (!synthesis?.speak || !synthesis?.getVoices) throw new Error('speech_unsupported');
      synthesis.resume?.(); // Remains synchronous in the user's click handler.
      language = normalizeVoiceLanguage(nextLanguage);
      voice = selectVoice(synthesis.getVoices(), language);
      if (!voice) throw new Error(language === 'en' ? 'english_voice_missing' : 'chinese_voice_missing');
      unlocked = true;
      return true;
    },
    resume() { if (unlocked) synthesis?.resume?.(); return this.ready; },
    stop() { active?.stop(); },
    play(volume = .5, { onStart, language: requestedLanguage = language } = {}) {
      requestedLanguage = normalizeVoiceLanguage(requestedLanguage);
      if (!this.ready) return Promise.reject(new Error('audio_suspended'));
      if (requestedLanguage !== language) return Promise.reject(new Error('voice_language_not_unlocked'));
      if (active || !Number.isFinite(volume) || volume <= 0) return Promise.resolve(false);
      // Some Chromium/WebKit builds pause speech while a tab is backgrounded.
      // Resume immediately before every utterance instead of trusting a stale
      // `paused` flag from the earlier enable click.
      synthesis.resume?.();
      return new Promise((resolve, reject) => {
        const utterance = makeUtterance(CANDIDATE_PHRASES[language]);
        utterance.voice = voice; utterance.lang = voice.lang;
        utterance.volume = Math.min(1, volume); utterance.rate = .9; utterance.pitch = 1.05;
        let timer, started = false;
        const finish = (ok, error) => {
          if (active?.utterance !== utterance) return;
          active = null; cancelTimer(timer);
          utterance.onstart = null; utterance.onend = null; utterance.onerror = null;
          if (error) { unlocked = false; reject(error); } else resolve(ok);
        };
        active = { utterance, stop() { finish(false); synthesis.cancel(); } };
        utterance.onstart = () => {
          if (active?.utterance !== utterance || started) return;
          started = true;
          try {
            if (onStart?.() === false) { finish(false); synthesis.cancel(); }
          } catch { finish(false, new Error('speech_start_callback_failed')); synthesis.cancel(); }
        };
        utterance.onend = () => finish(started, started ? null : new Error('speech_did_not_start'));
        utterance.onerror = event => finish(false, new Error(event.error || 'speech_failed'));
        timer = schedule(() => { finish(false, new Error('speech_timeout')); synthesis.cancel(); }, 20_000);
        try { synthesis.speak(utterance); } catch (error) { finish(false, error); }
      });
    }
  };
}
