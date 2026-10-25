/* Run 6, concept A (editorial): the few words this concept needs beyond the shared copy in lib/features.ts, which
   carries every feature, fact and answer. Running heads, the figure's caption and the descriptions of the small demos
   for screen readers. Danish, sentence case, no em dashes, no exclamation marks. */

// TODO(copy): every string in this file (run 6, concept A)
export const ED = {
  /** the running head over each part of the page, after its number */
  heads: {
    plate: "Fig. 1",
    features: "Funktioner",
    privacy: "Privatliv",
    free: "Pris",
    start: "Kom i gang",
    faq: "Spørgsmål",
  },
  /** the numbers of the list, in its running head */
  featuresRange: "01–06",
  /** what the numbered list is called */
  featuresTitle: "Seks ting, den kan",
  /** the section around Fig. 1, for screen readers */
  plateLabel: "Sådan ser det ud",
  plateCaption: "Hold fn nede, og tal. Når du slipper, lander linjen i det program, du skriver i.",
  /** the one computer window */
  window: {
    title: "Ny besked",
    to: "Til",
    toName: "Mette Holm",
    subject: "Emne",
    subjectText: "Referat fra mødet",
  },
  plateAria:
    "En ny mail på en computer. Mens fn holdes nede, står der Lytter nederst i vinduet, og mailen er tom. Når fn slippes, står sætningen i mailen: Jeg sender referatet fra mødet i morgen tidlig, så vi kan tage beslutningen torsdag.",
  /** the small demos in the numbered list */
  demo: {
    mac: "Mac",
    windows: "Windows",
    or: "eller",
    rightCtrl: "højre",
    said: "Du siger",
    written: "Der står",
    cleanup: "AI-oprydning",
    devWords: "Udviklerord",
    computer: "MacBook",
  },
  demoAria: {
    fn: "Tasten fn på en Mac, eller højre Ctrl på Windows.",
    phone: "Telefonappens knap i tre trin: Hold for at tale, Slip for at sende, Klar på MacBook.",
    corrections:
      "Du siger: Lad os mødes onsdag, nej, torsdag klokken ti. Med AI-oprydning står der: Lad os mødes torsdag klokken ti.",
    mixed:
      "En dansk sætning med engelske ord: Jeg merger din pull request efter standup og deployer til staging.",
    words:
      "Ordlisten: walkie talkey bliver til WalkieTalkey, mette holm til Mette Holm og navigent til Navigent.",
    notify:
      "En besked på computeren fra WalkieTalkey: Tekst klar til at indsætte. Husk at bestille bord til fredag. Tryk ⌘V.",
  },
  /** links under privacy */
  privacyMore: "Læs om privatliv",
  securityMore: "Sikkerhed",
  /** the open-source colophon */
  colophon: {
    licence: "Licens",
    code: "Kode",
  },
};
