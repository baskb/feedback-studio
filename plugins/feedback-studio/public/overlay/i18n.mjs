// Feedback Studio — the overlay's UI language: English or Dutch.
//
// The English wording IS the key: code says t('Marked resolved') and the Dutch
// table maps that sentence to its translation. A missing entry shows the
// English, never a blank. {name} placeholders are filled from `vars`.
// test/i18n.test.mjs scans every overlay module for t('…') calls and fails
// when a sentence has no Dutch entry, so the table cannot fall behind.
//
// The language comes from the browser (nl-*) unless the reviewer picked one
// with the EN/NL switch in the List, which is remembered per browser. This
// module reads nothing from `window` at load time so the tests can import it.

import { NL_EXTRA } from '/__feedback/overlay/i18n-extra.mjs';

export const LANG_CODES = ['en', 'nl'];

// Core strings: the List, the composer, pins, toasts, sorting, search, bulk
// actions, rounds, history, keyboard help. The long tail (Tweak Mode, image
// replace, narration, variants) lives in i18n-extra.mjs.
const NL_CORE = {
  // shell
  'Feedback': 'Feedback',
  'Theme': 'Thema',
  'Close': 'Sluiten',
  'Close feedback panel': 'Feedbackpaneel sluiten',
  'Switch language': 'Taal wisselen',
  'Filter comments': 'Opmerkingen filteren',
  'All': 'Alle',
  'Open': 'Open',
  'Resolved': 'Opgelost',
  'Today': 'Vandaag',
  'Comments added or changed today': 'Opmerkingen die vandaag zijn toegevoegd of gewijzigd',
  'This round': 'Deze ronde',
  'Comments from the current review round': 'Opmerkingen uit de huidige beoordelingsronde',
  'Search comments': 'Opmerkingen zoeken',
  'Search…': 'Zoeken…',
  'Clear search': 'Zoekopdracht wissen',
  'Sort by': 'Sorteren op',
  'Latest activity': 'Laatste activiteit',
  'Date created': 'Aanmaakdatum',
  'Position on page': 'Positie op de pagina',
  'Needs attention': 'Vraagt aandacht',
  'Status': 'Status',
  'Type': 'Type',
  'Most discussed': 'Meest besproken',
  'Ascending': 'Oplopend',
  'Descending': 'Aflopend',
  'Flip the sort direction': 'Sorteerrichting omdraaien',
  'List': 'Lijst',
  'Talk': 'Praten',
  'Point': 'Aanwijzen',
  'Feedback list': 'Feedbacklijst',
  'Open feedback list': 'Feedbacklijst openen',
  'Talk — narrate the page by voice (T)': 'Praten — vertel over de pagina met je stem (T)',
  'Talk (narrate the page), shortcut T': 'Praten (vertel over de pagina), sneltoets T',
  'Point at an element to comment (P)': 'Wijs een element aan om een opmerking te plaatsen (P)',
  'Play a guided tour of what the agent changed, read aloud': 'Speel een rondleiding af langs wat de agent veranderde, voorgelezen',
  'Walk me through the changes': 'Neem me mee door de wijzigingen',
  'Write these comments into the .md as @FB markers (portable + greppable)': 'Schrijf deze opmerkingen als @FB-markeringen in het .md-bestand (draagbaar en doorzoekbaar)',
  'Stamp .md': 'Stempel .md',
  'History': 'Geschiedenis',
  'Versions of this document and what changed between them': 'Versies van dit document en wat er tussen versies veranderde',
  'Saved to .feedback/ — say this to your coding agent to apply the comments': 'Opgeslagen in .feedback/ — zeg dit tegen je codeer-agent om de opmerkingen toe te passen',
  'Tell your agent:': 'Zeg tegen je agent:',
  'Saved to .feedback/comments.json + FEEDBACK.md': 'Opgeslagen in .feedback/comments.json en FEEDBACK.md',
  'Keyboard shortcuts': 'Sneltoetsen',
  'This feedback session: {label}': 'Deze feedbacksessie: {label}',
  'Round {n}': 'Ronde {n}',
  'Start a new review round': 'Nieuwe beoordelingsronde starten',
  'New round': 'Nieuwe ronde',
  'Round {n} started': 'Ronde {n} gestart',
  'Could not start a new round — {error}': 'Kon geen nieuwe ronde starten — {error}',

  // panel summary + empty states
  '{n} comment': '{n} opmerking',
  '{n} comments': '{n} opmerkingen',
  '{n} open': '{n} open',
  '{n} from your agent to review': '{n} van je agent om te beoordelen',
  'Nothing in this filter.': 'Niets in dit filter.',
  'Nothing matches your search.': 'Niets gevonden voor je zoekopdracht.',
  'No comments yet.': 'Nog geen opmerkingen.',
  'Turn on Point mode and click anything on the page.': 'Zet Aanwijzen aan en klik op iets op de pagina.',
  'Press {key} to toggle Point mode.': 'Druk op {key} om Aanwijzen aan of uit te zetten.',
  'No comments yet': 'Nog geen opmerkingen',
  '{n} comment ready for your agent': '{n} opmerking klaar voor je agent',
  '{n} comments ready for your agent': '{n} opmerkingen klaar voor je agent',
  'All resolved': 'Alles opgelost',
  'this page': 'deze pagina',

  // cards
  'you': 'jij',
  'host': 'eigenaar',
  'agent': 'agent',
  'The pinned text changed after the agent replied. If the change is what you asked for, resolve the comment (✓) and the pin turns green; otherwise re-pin it.': 'De vastgepinde tekst is veranderd nadat de agent antwoordde. Is de wijziging wat je vroeg, los de opmerking dan op (✓) en de pin wordt groen; anders pin je hem opnieuw vast.',
  'changed after reply': 'gewijzigd na antwoord',
  'The pinned element could not be found on this page.': 'Het vastgepinde element is niet gevonden op deze pagina.',
  'The pinned element was only found with weak confidence — the agent will refuse to edit it.': 'Het vastgepinde element is maar met weinig zekerheid gevonden — de agent weigert het te bewerken.',
  'pin lost': 'pin kwijt',
  'pin unsure': 'pin onzeker',
  '{name} is on this': '{name} is hiermee bezig',
  'next up for {name}': 'hierna voor {name}',
  'Replacement image — open full size': 'Vervangende afbeelding — open op volledige grootte',
  'New image — click to open': 'Nieuwe afbeelding — klik om te openen',
  'replaces the background': 'vervangt de achtergrond',
  'replaces the image': 'vervangt de afbeelding',
  'Element screenshot at pin time — open full size': 'Schermafbeelding van het element bij het vastpinnen — open op volledige grootte',
  'What this looked like when pinned — click to open': 'Zo zag dit eruit bij het vastpinnen — klik om te openen',
  'Before': 'Voor',
  'After': 'Na',
  'Before and after: drag the handle to compare': 'Voor en na: sleep de greep om te vergelijken',
  'Try {n} option on the page': 'Probeer {n} optie op de pagina',
  'Try {n} options on the page': 'Probeer {n} opties op de pagina',
  'Picked: {label}': 'Gekozen: {label}',
  'Reply to this thread…': 'Reageer in dit gesprek…',
  'Send reply': 'Antwoord versturen',
  'Approve': 'Goedkeuren',
  'Reject': 'Afwijzen',
  '{n} reply': '{n} antwoord',
  '{n} replies': '{n} antwoorden',
  'Re-pin on the page': 'Opnieuw vastpinnen op de pagina',
  'Go to element': 'Ga naar element',
  'Edit': 'Bewerken',
  'Resolve': 'Oplossen',
  'Reopen': 'Heropenen',
  'Delete': 'Verwijderen',
  'Drag the pin onto another element to move it': 'Sleep de pin naar een ander element om hem te verplaatsen',

  // card actions and toasts
  'That text is no longer in the document — nothing to scroll to.': 'Die tekst staat niet meer in het document — er is niets om naartoe te scrollen.',
  "Couldn't locate this element on the page — it may need a re-pin.": 'Kon dit element niet vinden op de pagina — het moet misschien opnieuw worden vastgepind.',
  'Click the element this comment is about (Esc cancels)': 'Klik op het element waar deze opmerking over gaat (Esc annuleert)',
  'Pin moved.': 'Pin verplaatst.',
  'Could not move the pin — {error}': 'Kon de pin niet verplaatsen — {error}',
  'Marked resolved': 'Gemarkeerd als opgelost',
  'Reopened': 'Heropend',
  'Approved — your agent can implement it': 'Goedgekeurd — je agent kan het uitvoeren',
  'Rejected': 'Afgewezen',
  'Update failed — {error}': 'Bijwerken mislukt — {error}',
  'Reply sent': 'Antwoord verstuurd',
  'Reply failed — {error}': 'Antwoord versturen mislukt — {error}',
  'Comment deleted': 'Opmerking verwijderd',
  'Delete failed — {error}': 'Verwijderen mislukt — {error}',
  'Undo': 'Ongedaan maken',
  'Undone: {what}': 'Ongedaan gemaakt: {what}',
  'Nothing to undo': 'Niets om ongedaan te maken',
  'Could not undo — {error}': 'Kon niet ongedaan maken — {error}',
  'Comment updated': 'Opmerking bijgewerkt',
  'Comment saved': 'Opmerking opgeslagen',
  'Saved — the page reverts; your agent applies it to source': 'Opgeslagen — de pagina gaat terug naar hoe hij was; je agent past het toe in de broncode',
  'Save failed — {error}': 'Opslaan mislukt — {error}',
  'Image upload failed — {error}': 'Afbeelding uploaden mislukt — {error}',
  'Could not load comments — {error}': 'Kon opmerkingen niet laden — {error}',
  'Comments file unreadable — check .feedback/comments.json': 'Opmerkingenbestand onleesbaar — controleer .feedback/comments.json',
  'Page updated by your agent': 'Pagina bijgewerkt door je agent',
  'Reload now': 'Nu herladen',
  'Applying your agent’s edits — reloading…': 'Wijzigingen van je agent worden toegepast — herladen…',
  'Stamped {n} marker into {files}': '{n} markering gestempeld in {files}',
  'Stamped {n} markers into {files}': '{n} markeringen gestempeld in {files}',
  '{n} file': '{n} bestand',
  '{n} files': '{n} bestanden',
  ' ({n} skipped — no unique matching line/file; re-pin those)': ' ({n} overgeslagen — geen unieke passende regel of bestand; pin die opnieuw vast)',
  'Stamp failed — {error}': 'Stempelen mislukt — {error}',
  'Language set to English': 'Taal ingesteld op Engels',
  'Language set to Dutch': 'Taal ingesteld op Nederlands',

  // bulk actions
  '{n} shown': '{n} getoond',
  'Resolve all': 'Alles oplossen',
  'Resolve every comment shown': 'Alle getoonde opmerkingen oplossen',
  'Delete all': 'Alles verwijderen',
  'Delete every comment shown': 'Alle getoonde opmerkingen verwijderen',
  'Copy': 'Kopiëren',
  'Copy the comments shown as Markdown': 'Kopieer de getoonde opmerkingen als Markdown',
  'Resolved {n} comment': '{n} opmerking opgelost',
  'Resolved {n} comments': '{n} opmerkingen opgelost',
  'Deleted {n} comment': '{n} opmerking verwijderd',
  'Deleted {n} comments': '{n} opmerkingen verwijderd',
  'Copied {n} comment as Markdown': '{n} opmerking gekopieerd als Markdown',
  'Copied {n} comments as Markdown': '{n} opmerkingen gekopieerd als Markdown',
  'Could not copy — {error}': 'Kon niet kopiëren — {error}',
  'Some changes failed — {error}': 'Sommige wijzigingen zijn mislukt — {error}',
  'resolving {n} comments': '{n} opmerkingen oplossen',
  'deleting {n} comments': '{n} opmerkingen verwijderen',
  'the status change': 'de statuswijziging',
  'the text change': 'de tekstwijziging',
  'the pin move': 'het verplaatsen van de pin',
  'the delete': 'het verwijderen',

  // composer
  'Edit comment': 'Opmerking bewerken',
  'Add a comment': 'Opmerking toevoegen',
  'Cancel': 'Annuleren',
  'text': 'tekst',
  'element': 'element',
  'Your name (shown with your comment)': 'Je naam (getoond bij je opmerking)',
  'Your name': 'Je naam',
  'Listening…': 'Luisteren…',
  'Dictate (voice to text)': 'Dicteren (spraak naar tekst)',
  'Voice not supported in this browser': 'Spraak wordt niet ondersteund in deze browser',
  'Voice language: {name}': 'Spraaktaal: {name}',
  'Voice language': 'Spraaktaal',
  'Update': 'Bijwerken',
  'Save': 'Opslaan',
  '{action} (⌘↵ / Ctrl+Enter)': '{action} (⌘↵ / Ctrl+Enter)',
  'What needs to change here? (typed or spoken)': 'Wat moet hier veranderen? (getypt of gesproken)',
  'Fix': 'Repareren',
  'Something is broken or wrong — reproduce and patch it.': 'Iets is kapot of fout — reproduceer het en repareer het.',
  'What’s broken, and what should happen instead? (typed or spoken)': 'Wat is er kapot, en wat zou er moeten gebeuren? (getypt of gesproken)',
  'Change': 'Wijzigen',
  'Make it exactly this — apply near-verbatim, no redesign.': 'Maak het precies zo — pas het vrijwel letterlijk toe, geen herontwerp.',
  'What should this say or look like? (typed or spoken)': 'Wat moet hier staan of hoe moet dit eruitzien? (getypt of gesproken)',
  'Improve': 'Verbeteren',
  'This is weak — rewrite or redesign with judgement.': 'Dit is zwak — herschrijf of herontwerp het naar eigen inzicht.',
  'What could be better here? (typed or spoken)': 'Wat kan hier beter? (getypt of gesproken)',
  'Ask': 'Vragen',
  'Ask about this — the agent answers in a reply, and does not change it.': 'Stel een vraag hierover — de agent antwoordt in een reactie en verandert niets.',
  'What’s your question about this? (typed or spoken)': 'Wat is je vraag hierover? (getypt of gesproken)',
  'Comment': 'Opmerking',
  'A general note about this passage.': 'Een algemene opmerking over deze passage.',
  'Your note on this passage (typed or spoken)': 'Je opmerking over deze passage (getypt of gesproken)',
  'Rephrase': 'Herformuleren',
  'Propose specific replacement wording.': 'Stel een concrete andere formulering voor.',
  'How should this be reworded? (typed or spoken)': 'Hoe moet dit anders worden geformuleerd? (getypt of gesproken)',
  'Expand': 'Uitbreiden',
  'Add more detail / content here.': 'Voeg hier meer detail of inhoud toe.',
  'What should be added or expanded on? (typed or spoken)': 'Wat moet worden toegevoegd of uitgebreid? (getypt of gesproken)',
  'Remove this passage.': 'Verwijder deze passage.',
  'Why should this be removed? (optional, typed or spoken)': 'Waarom moet dit weg? (optioneel, getypt of gesproken)',
  'Question': 'Vraag',
  'Ask the agent something about this.': 'Vraag de agent iets hierover.',

  // pins
  '[text changed after the agent replied — resolve it in the List if the change is what you asked for] ': '[tekst gewijzigd nadat de agent antwoordde — los het op in de Lijst als de wijziging is wat je vroeg] ',
  '[pin may be off — re-pin from the List] ': '[pin zit misschien verkeerd — pin opnieuw vast vanuit de Lijst] ',
  '[agent] ': '[agent] ',
  'Agent comment: ': 'Opmerking van de agent: ',
  'Comment: ': 'Opmerking: ',
  'Drop on the element this comment is about (Esc cancels)': 'Laat los op het element waar deze opmerking over gaat (Esc annuleert)',

  // keyboard help
  'Next pin': 'Volgende pin',
  'Previous pin': 'Vorige pin',
  'Open the highlighted comment': 'Gemarkeerde opmerking openen',
  'Reply to the highlighted comment': 'Reageren op de gemarkeerde opmerking',
  'Resolve the highlighted comment': 'Gemarkeerde opmerking oplossen',
  'Close what is open': 'Sluit wat open is',
  'Point mode on / off': 'Aanwijzen aan / uit',
  'Talk: narrate the page': 'Praten: vertel over de pagina',
  'Show or hide the List': 'Lijst tonen of verbergen',
  'Search the List': 'Zoeken in de Lijst',
  'Undo the last change': 'Laatste wijziging ongedaan maken',
  'This help': 'Deze hulp',
  'Never while typing in a text field.': 'Nooit terwijl je in een tekstveld typt.',
  'No pins on this page to move between.': 'Geen pins op deze pagina om tussen te wisselen.',

  // history (Markdown mode)
  'Back to the list': 'Terug naar de lijst',
  'Versions of {file}': 'Versies van {file}',
  'No versions yet. The first one is taken when the document is opened; a new one each time the file changes on disk.': 'Nog geen versies. De eerste wordt gemaakt als het document wordt geopend; daarna één bij elke wijziging van het bestand op schijf.',
  'Could not load the history — {error}': 'Kon de geschiedenis niet laden — {error}',
  'opened': 'geopend',
  'changed on disk': 'gewijzigd op schijf',
  'batch': 'batch',
  'restored': 'teruggezet',
  'manual': 'handmatig',
  'while on #{n}': 'tijdens #{n}',
  'after #{list} resolved': 'na oplossen van #{list}',
  'from': 'van',
  'to': 'tot',
  'No differences between these two versions.': 'Geen verschillen tussen deze twee versies.',
  'Put the document back to this version (the current text is kept as a new version first)': 'Zet het document terug naar deze versie (de huidige tekst wordt eerst als nieuwe versie bewaard)',
  'Restored version {n} — the page reloads': 'Versie {n} teruggezet — de pagina wordt herladen',
  'Restore failed — {error}': 'Terugzetten mislukt — {error}',
  'Take a snapshot now': 'Nu een momentopname maken',
  'Snapshot saved as v{n}': 'Momentopname opgeslagen als v{n}',
  'No change since the last version.': 'Geen wijziging sinds de laatste versie.',
  'Snapshot failed — {error}': 'Momentopname mislukt — {error}',
  'The document changed on disk (v{n}: +{a} −{r})': 'Het document is gewijzigd op schijf (v{n}: +{a} −{r})',
  'Show what changed': 'Toon wat er veranderde',
  'Only changes': 'Alleen wijzigingen',
  'Line {n}': 'Regel {n}',

  // times
  'just now': 'zojuist',
  '{n}m ago': '{n} min geleden',
  '{n}h ago': '{n} uur geleden',
  '{n}d ago': '{n} dagen geleden',
};

export const TABLES = { nl: { ...NL_CORE, ...NL_EXTRA } };

let current = null;

// 'nl' for a Dutch browser, unless the reviewer chose a language themselves.
export function detectLang(navLang, stored) {
  if (stored && LANG_CODES.includes(stored)) return stored;
  return String(navLang || '').toLowerCase().startsWith('nl') ? 'nl' : 'en';
}
// Decided on the first call, from the browser and the remembered choice, so a
// module that builds a string table at load time gets the right language no
// matter which module happens to load first. Outside a browser (the tests)
// there is no storage, and English is used.
function ensureInit() {
  if (current) return;
  let stored = null;
  let nav = '';
  try { stored = window.localStorage.getItem('kbf-lang'); } catch (e) {}
  try { nav = navigator.language; } catch (e) {}
  current = detectLang(nav, stored);
}
export function initI18n(code) { current = LANG_CODES.includes(code) ? code : 'en'; }
export function getLang() { ensureInit(); return current; }
// Remember the reviewer's choice for this browser. The page reloads to redraw
// every label; the List and Point mode state survive the reload.
export function setLang(code) {
  if (!LANG_CODES.includes(code)) return;
  try { window.localStorage.setItem('kbf-lang', code); } catch (e) {}
  current = code;
}

function fill(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Translate one sentence. `vars` fills {placeholders}.
export function t(s, vars) {
  ensureInit();
  const table = current === 'en' ? null : TABLES[current];
  const out = table && Object.prototype.hasOwnProperty.call(table, s) ? table[s] : s;
  return fill(out, vars);
}

// Singular / plural: tn('{n} comment', '{n} comments', n).
export function tn(one, other, n, vars) {
  return t(n === 1 ? one : other, { n, ...(vars || {}) });
}
