/**
 * Every word the phone app shows. Strings from spec Appendix A ("Phone") are used verbatim; the
 * main screen's state labels come from the design system (PHONE_LABELS, also Appendix A).
 * Strings marked TODO(copy) are drafts that the owner approves before release.
 * Rules: Danish, sentence case, no em dashes, no exclamation marks, no emoji.
 */

export const T = {
  // Appendix A, Phone (verbatim)
  pairTitle: "Par med en computer",
  scan: "Scan koden på din computer",
  noSpeech: "Hørte ikke noget",
  removed: "Parringen med {computer} er fjernet. Par igen for at bruge den.",
  expired: "Koden er udløbet. Lav en ny på computeren.",
  micDenied:
    "WalkieTalkey skal bruge mikrofonen. Slå den til i indstillingerne.",
  noConnection: "Ingen forbindelse. Prøver igen.",
  installTitle: "Føj WalkieTalkey til hjemmeskærmen for at bruge den",
  openFromHome: "Åbn WalkieTalkey fra hjemmeskærmen og scan koden der.",
  retry: "Prøv igen",
  somethingWrong: "Noget gik galt. Prøv igen.",
  details: "Detaljer",
  lock: "Krypteret fra telefon til computer",
  holdToTalk: "Hold for at tale",

  // Spec section 7.6
  settings: "Indstillinger",
  pairedComputers: "Parrede computere",
  remove: "Fjern",
  haptics: "Haptik",
  about: "Om og licenser",
  cancel: "Annullér",

  // TODO(copy): first screen, the short explanation under "Par med en computer" (PHONE-10)
  pairIntro:
    "Åbn WalkieTalkey på din computer, vælg Indstillinger, Telefon og Par en telefon. Scan så koden, der kommer frem.",
  // TODO(copy): install steps in a Safari tab (PHONE-04)
  installSteps: [
    "Tryk på Del-knappen nederst i Safari.",
    "Vælg Føj til hjemmeskærm, og tryk Tilføj.",
    "Åbn WalkieTalkey fra hjemmeskærmen.",
  ],
  // TODO(copy): Phase 5, opened from a pairing link in a Safari tab: the home-screen app pairs itself
  installOpenPairs:
    "Åbn WalkieTalkey fra hjemmeskærmen. Den parrer med {computer} med det samme.",
  installInTime: "Koden på computeren virker i 10 minutter.",
  installAlready: "Har du allerede WalkieTalkey på hjemmeskærmen?",
  // TODO(copy): why a Safari tab is not enough (PHONE-04)
  installWhy:
    "Appen på hjemmeskærmen gemmer parringen sikkert. En fane i Safari kan glemme den.",
  // TODO(copy): scanner
  scanHint: "Ret kameraet mod koden på computeren.",
  // TODO(copy): camera permission refused
  cameraDenied:
    "WalkieTalkey skal bruge kameraet for at scanne koden. Slå det til i indstillingerne.",
  // TODO(copy): no camera or no QR decoding available
  cameraUnavailable: "Kameraet kunne ikke starte.",
  // TODO(copy): scanned something that is not a WalkieTalkey code
  notACode: "Det er ikke en kode fra WalkieTalkey.",
  // TODO(copy): the phone's name (PHONE-12)
  nameTitle: "Hvad hedder telefonen?",
  nameHint: "Navnet vises på {computer}, så du kan kende telefonen igen.",
  nameLabel: "Telefonens navn",
  pairButton: "Par telefonen",
  pairing: "Parrer med {computer}",
  // TODO(copy): the computer is full (8 devices per room)
  roomFull:
    "Der er allerede parret 8 enheder med {computer}. Fjern en på computeren først.",
  // TODO(copy): generic buttons
  ok: "OK",
  back: "Tilbage",
  // TODO(copy): the computer picker (PHONE-41)
  pickTitle: "Send til",
  online: "Online",
  offline: "Ikke online",
  // TODO(copy): settings details
  removeConfirm: "Fjern parringen med {computer}?",
  removeHint:
    "Telefonen kan ikke længere sende til {computer}. Du kan altid parre igen.",
  noComputers: "Ingen computere endnu.",
  hapticsOn: "Lille vibration, når optagelsen starter og stopper",
  phoneName: "Navn på {computer}: {name}",
  // TODO(copy): about and licences (spec 7.6)
  aboutLines: [
    "WalkieTalkey er gratis og open source under Apache-2.0-licensen.",
    "Talen bliver til tekst på din egen computer.",
    "Krypteret fra telefon til computer.",
    "Ingen konto. Ingen sporing.",
  ],
  credits:
    "Bygget med React (MIT), jsQR (Apache-2.0) og skrifttypen Albert Sans (SIL Open Font License 1.1).",
  version: "Version {version}",
  sourceCode: "Kildekode",
  // TODO(copy): hands-free (PHONE-26), wording from the run 2 brief; shown with a lock
  tapAgainToStop: "Tryk igen for at stoppe",
  // TODO(copy): the status line at the top of the main screen (run 2, Phase 4)
  statusOnline: "Forbundet til {computer}",
  statusAway: "{computer} er ikke online",
  statusConnecting: "Forbinder til {computer}",
  statusLost: "Ikke forbundet til {computer}",
  // TODO(copy): run 5, a computer the relay has not seen for days (maybe reset or reinstalled)
  statusGone: "{computer} har ikke været online i {days} dage",
  // TODO(copy): run 5, offered when a pairing may be stale (spec 5.4)
  pairAgain: "Par igen",
  repairHint:
    "Er {computer} nulstillet eller installeret igen? Så skal telefonen parres igen.",
  // TODO(copy): what the status line does when tapped (screen readers)
  statusPick: "Vælg computer og indstillinger",
  // TODO(copy): the 5 minute limit (PHONE-29)
  countdown: "Optagelsen stopper om {seconds} sekunder",
  // TODO(copy): "Detaljer" texts (PHONE-25)
  detail: {
    model_not_ready: "Talemodellen er ikke klar endnu",
    too_long: "Optagelsen var for lang. Den kan højst vare 5 minutter.",
    error: "Computeren kunne ikke lave optagelsen om til tekst.",
    buffer_full: "Relæet havde ikke plads til optagelsen. Prøv igen om lidt.",
    mic: "Mikrofonen kunne ikke starte. Luk andre apps, der bruger den, og prøv igen.",
    insecure: "Siden er ikke åbnet sikkert, så telefonen kan ikke kryptere.",
    unknown: "Der skete en uventet fejl.",
  } as Record<string, string>,
  detailCode: "Kode: {code}",
} as const;

/** Fills {name} placeholders. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in values ? values[k]! : m,
  );
}
