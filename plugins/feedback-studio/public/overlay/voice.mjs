// Feedback Studio — voice dictation inside the composer (Web Speech API).

import { S, SR, LS, langName, langShort } from '/__feedback/overlay/state.mjs';
import { toast } from '/__feedback/overlay/ui.mjs';
import { norm } from '/__feedback/overlay/dom.mjs';
import { t } from '/__feedback/overlay/i18n.mjs';

export function stopRecognition() {
  S.voiceManualStop = true;
  if (S.recognition) { try { S.recognition.stop(); } catch (e) {} }
  S.recognizing = false;
}

function appendSentence(a, b) {
  a = a.trim(); b = b.trim();
  if (!a) return b;
  if (!b) return a;
  return a + ' ' + b;
}

export function setVoiceLang(code, box, micBtn, hintText) {
  S.speechLang = code;
  LS.set('kbf-voicelang', code);
  const chip = box.querySelector('.kbf-lang');
  if (chip) chip.textContent = langShort(code);
  const wrap = box.querySelector('.kbf-langwrap');
  if (wrap) wrap.title = 'Voice language: ' + langName(code);
  const sel = box.querySelector('.kbf-langselect');
  if (sel && sel.value !== code) sel.value = code;
  if (hintText) hintText.textContent = t('Listening… ({name})', { name: langName(code) });
  // a live language switch takes effect on the next dictation start
  if (S.recognizing) { stopRecognition(); if (micBtn) micBtn.classList.remove('is-recording'); }
  toast(t('Voice language: {name}', { name: langName(code) }));
}

export function toggleRecognition(ta, micBtn, hint, hintText, validate, autoGrow) {
  if (!SR) return;
  const setPressed = (on) => {
    micBtn.classList.toggle('is-recording', on);
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    hint.classList.toggle('is-on', on);
  };
  if (S.recognizing) { stopRecognition(); setPressed(false); return; }
  S.voiceManualStop = false;
  let voiceErrored = false;
  if (hintText) hintText.textContent = t('Listening… ({name})', { name: langName(S.speechLang) });
  const recognition = new SR();
  S.recognition = recognition;
  recognition.lang = S.speechLang;
  recognition.interimResults = true;
  recognition.continuous = true;
  let committed = ta.value;
  let lastApplied = ta.value;
  // Mobile Web Speech re-emits a GROWING cumulative final in quick succession
  // ("so" → "so explain" → "so explain me"…), so a plain append repeats the
  // words over and over. Same collapse rule as the narration recognizer: a
  // final arriving shortly after the previous one that extends it (or is a
  // prefix of it) REPLACES it on the same base instead of appending. Compared
  // case-insensitively — mobile recognisers re-capitalise the re-emit.
  let lastFinal = null; // { text, t, base } — base = committed BEFORE this chain
  recognition.onresult = (e) => {
    // If the user typed into the box since our last write, adopt that as the
    // base so manual edits made while dictating aren't discarded.
    if (ta.value !== lastApplied) { committed = ta.value; lastFinal = null; }
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const seg = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        const txt = norm(seg);
        if (!txt) continue;
        const now = Date.now();
        const a = txt.toLowerCase(), b = lastFinal ? lastFinal.text.toLowerCase() : '';
        if (lastFinal && (now - lastFinal.t) < 1400 && (a.startsWith(b) || b.startsWith(a))) {
          if (txt.length >= lastFinal.text.length) { // grown — replace, don't append
            committed = appendSentence(lastFinal.base, txt);
            lastFinal = { text: txt, t: now, base: lastFinal.base };
          } else lastFinal.t = now; // shorter re-emit of the same phrase — ignore
        } else {
          lastFinal = { text: txt, t: now, base: committed };
          committed = appendSentence(committed, txt);
        }
      } else interim += seg;
    }
    const val = interim ? appendSentence(committed, interim) : committed;
    ta.value = val; lastApplied = val;
    validate(); autoGrow();
  };
  recognition.onerror = (ev) => {
    voiceErrored = true;
    const msg = {
      'not-allowed': t('Microphone blocked — allow mic access'),
      'service-not-allowed': t('Microphone blocked — allow mic access'),
      'no-speech': t('No speech detected — try again'),
      'audio-capture': t('No microphone found'),
      'network': t('Voice recognition network error'),
    }[ev.error];
    if (msg) toast(msg);
  };
  recognition.onend = () => {
    // The engine auto-stops after a silence; keep listening unless the user
    // toggled off or an error ended it.
    if (!S.voiceManualStop && !voiceErrored) {
      try { S.recognition.start(); return; } catch (e) {}
    }
    S.recognizing = false;
    setPressed(false);
  };
  try { S.recognition.start(); S.recognizing = true; setPressed(true); }
  catch (e) { S.recognizing = false; setPressed(false); }
}
