/* Every text Værkstedet shows. Danish, du-form, short sentences, sentence case, no em dashes
   (test/strings.test.ts). Numbers come in already formatted (lib/format.ts). Where the recorder
   page (wt_train/recorder/static/app.js) already says a thing, the same words are used. */
import type { Band } from "./lib/level";

export const S = {
  app: {
    name: "Værkstedet",
    sub: "Træning af Edda",
    skip: "Gå til indholdet",
  },

  nav: {
    label: "Værkstedets sider",
    optag: "Optagelse",
    data: "Data",
    ord: "Dine egne ord",
    traening: "Træning",
    evaluering: "Evaluering",
    versioner: "Versioner",
    journal: "Journal",
    laer: "Lær det",
  },

  status: {
    label: "Status",
    appFound: (version: string) => `WalkieTalkey ${version}`,
    appFoundNoVersion: "WalkieTalkey er fundet",
    appMissing: "WalkieTalkey er ikke fundet",
    noBatch: "Appen kan ikke lytte til optagelser",
    nothingRuns: "Intet kører lige nu",
    recording: (label: string) => `Optager: ${label}`,
    paused: (label: string) => `På pause: ${label}`,
    training: (config: string) => `Træner: ${config}`,
    offline: "Værkstedet svarer ikke",
  },

  common: {
    loading: "Henter",
    retry: "Prøv igen",
    close: "Luk",
    back: "Tilbage",
    cancel: "Annullér",
    start: "Start",
    log: "Log",
    showLog: "Vis loggen",
    hideLog: "Skjul loggen",
    showTable: "Vis tallene som tabel",
    none: "ingen",
    yes: "ja",
    no: "nej",
    job: {
      running: "Kører",
      done: "Færdig",
      failed: "Fejlede",
      stopped: "Stoppet",
    } as Record<string, string>,
    started: (when: string) => `Startet ${when}`,
    emptyLog: "Loggen er tom indtil videre.",
  },

  /* Every error code of API.md, by route where the same code means different things. */
  errors: {
    generic: "Noget gik galt. Prøv igen.",
    network: "Værkstedet svarer ikke. Kører wt-train studio stadig?",
    forbidden: "Værkstedet afviste handlingen. Hent siden igen.",
    json: "Værkstedet forstod ikke handlingen. Hent siden igen.",
    "too-long": "Teksten er for lang til at blive gemt.",
    "not-found": "Det findes ikke længere. Hent siden igen.",
    "bad-response": "Værkstedet svarede med noget, siden ikke forstår.",
    since: "Siden og Værkstedet er kommet ud af trit. Hent siden igen.",
    busy: "Det kan ikke lade sig gøre, mens noget andet er i gang.",
    unknown: "Det kender Værkstedet ikke. Hent siden igen.",
    "no-share": "Forholdet har ingen andel i mixet, så det kan ikke startes.",
    "bad-setup": "Opsætningen kendes ikke.",
    "no-pick": "Vælg en optagelse først.",
    paused: "Optagelsen er sat på pause. Tryk Fortsæt først.",
    "mac-not-ready":
      "Mac'en kan ikke optage lige nu. Er WalkieTalkey åben, og er det en optagelse på Mac'en?",
    config: "Konfigurationen har en fejl og kan ikke indlæses.",
    "no-configs": "Der er ingen konfigurationer i training/configs.",
    "not-running": "Der kører ingen træning.",
    "tracking-off":
      "Sporingen (MLflow) er slået fra, så der er ingen kørsler at vise.",
    "no-folder":
      "Kørslens klip ligger ikke i en evalueringsmappe, så der kan ikke laves en rapport.",
    "not-comparable":
      "Kørsel B har ingen resultater for kørsel A's datasæt, så de kan ikke sammenlignes.",
    "report-failed": "Rapporten kunne ikke laves. Se loggen.",
    version: "Den version kendes ikke.",
    "use-failed": "WalkieTalkey kunne ikke skifte model.",
    text: "Noterne kunne ikke gemmes. Prøv igen.",
    exists: "Den findes allerede.",
    "no-vscode":
      "VS Code er ikke fundet på Mac'en. Installér VS Code, og prøv igen.",
    mix: "Andelene skal være hele procent, der giver 100 tilsammen.",
    recording: "Stop optagelsen først. Så kan sætningerne deles ud igen.",
    confirm: "Bekræft først, at du vil bruge testsættet.",
    dataset: "Vælg valideringen eller testsættet.",
    backend: "Vælg en model at måle.",
    "no-build":
      "Datasættet er ikke bygget endnu. Byg det i terminalen, og prøv igen.",
    "no-split": "Træningen har ikke gemt den del af datasættet.",
    word: "Ordet kunne ikke gemmes. Hent siden igen.",
    length: "En sætning skal have 4 til 20 ord.",
    dash: "Brug komma eller punktum i stedet for tankestreg.",
    "no-word": "Ordet skal stå i sætningen.",
    duplicate: "Den sætning findes allerede.",
    "own-words":
      "Filen med dine ord kan ikke læses. Ret den i hånden, eller slet den.",
    "own-sentences":
      "Filen med dine sætninger har en forkert første linje. Ret den i hånden.",
  } as Record<string, string>,

  errorsIn: {
    recording: {
      busy: "Vent, til optagelsen er færdig.",
      unknown: "Den sætning findes ikke i denne optagelse. Hent siden igen.",
    },
    pilot: { busy: "Sammenligningen kører allerede." },
    data: { unknown: "Konfigurationen findes ikke." },
    training: {
      busy: "Der kører allerede en træning.",
      unknown: "Konfigurationen findes ikke.",
    },
    evaluation: { unknown: "Kørslen findes ikke længere i MLflow." },
    measure: {
      busy: "Der kører allerede en måling.",
      unknown:
        "Træningen eller datasættet findes ikke længere. Hent siden igen.",
    },
    mix: {
      busy: "Sætningerne bliver allerede delt ud. Vent et øjeblik.",
    },
    ownwords: {
      text: "Sætningen kunne ikke læses. Prøv igen.",
    },
    versions: {
      busy: "Der kører allerede en eksport.",
      unknown: "Træningen har ingen adapter, der kan eksporteres.",
    },
    journal: {
      unknown: "Kørslen eller siden findes ikke.",
      exists: "Der findes allerede en side for den kørsel.",
    },
    learn: { unknown: "Notesbogen findes ikke længere. Hent siden igen." },
  } as Record<string, Record<string, string>>,

  recording: {
    title: "Optagelse",
    intro:
      "Indtal sætningerne til træningen. Hver optagelse bliver tjekket, og Edda lytter med.",

    pickTitle: "Vælg, hvad du vil optage",
    pickAgain: "Vælg en anden optagelse",
    pickReplaces:
      "En ny optagelse afløser den, der er i gang. Det, du har optaget, bliver.",
    conditions: "Rigtige forhold",
    conditionsHelp: "Sætningerne til træningen, fordelt efter mixet.",
    conditionDone: (done: string, planned: string) =>
      `${done} af ${planned} sætninger`,
    conditionShare: (share: string) => `${share} af mixet`,
    conditionRedo: (n: string) => `${n} skal tages om`,
    noShare: "Har ingen andel i mixet endnu, så den kan ikke startes.",
    noShareShort: "Ingen andel i mixet",
    exam: "Eksamen",
    examToggle: (n: string) =>
      `Optag eksamensafsnittene (${n}) i stedet for sætningerne`,
    examHelp:
      "Eksamen er lange afsnit, som aldrig bruges til træning, kun til at bedømme modellen.",
    examProgress: (done: string, total: string) =>
      `Eksamen: ${done} af ${total} afsnit`,
    pilot: "Piloten",
    pilotHelp: (n: string) =>
      `Det er en pilot: ${n} sætninger pr. opsætning, så du kan høre, om lyden er god, før du indtaler i timevis. Optagelserne bruges kun til at sammenligne opsætningerne og aldrig til træning.`,
    suggested: "Foreslået",
    setupDone: (done: string, total: string) => `${done} af ${total}`,
    phone: "Telefonen",
    mac: "Mac'en",
    start: "Start optagelsen",
    starting: "Starter",
    pickFirst: "Vælg en optagelse først.",

    kind: {
      condition: "Sætninger",
      exam: "Eksamen",
      pilot: "Pilot",
    },

    link: {
      connectedPhone: (phone: string) =>
        `Forbundet. Sætningerne vises på ${phone}`,
      connectedPhoneOffline: (phone: string) =>
        `Forbundet, men ${phone} er ikke online. Åbn WalkieTalkey på telefonen.`,
      connectedMac: "Forbundet til WalkieTalkey på Mac'en",
      connecting: "Forbinder til WalkieTalkey",
      waiting: "Venter på WalkieTalkey",
      not_running: "Åbn WalkieTalkey på Mac'en",
      no_phone: "Ingen telefon er parret. Par telefonen i WalkieTalkey.",
      gone: "WalkieTalkey har lukket forbindelsen. Sæt på pause, og fortsæt for at forbinde igen.",
      error: "Forbindelsen til WalkieTalkey fejlede",
      paused: "På pause. Telefonen er tilbage til almindelig diktering.",
      pausedMac: "På pause. Der optages ikke, før du fortsætter.",
      stopped: "Optagelsen er stoppet.",
      thePhone: "telefonen",
    },

    mic: (name: string) => `Mikrofon: ${name}`,
    micMacDefault: "Mikrofon: Mac'ens standardmikrofon",
    micPhoneUnknown:
      "Mikrofon: telefonens, navnet kommer med den første optagelse",
    pause: "Pause",
    resume: "Fortsæt",
    stop: "Stop",
    skip: "Spring over",
    progress: (approved: string, total: string) =>
      `${approved} af ${total} godkendt`,
    recorded: (minutes: string) => `${minutes} optaget`,
    redoCount: (n: string) => `${n} skal tages om`,
    receivedCount: (n: string) => `${n} bliver tjekket`,
    serverError: "Optagelsen har en fejl:",
    refused: {
      silent: "Hørte ikke noget. Optag den igen.",
      gaps: "Noget af lyden nåede ikke frem. Optag den igen.",
      error: "Optagelsen kunne ikke gemmes.",
    } as Record<string, string>,
    refusedOther: "Optagelsen blev ikke gemt. Optag den igen.",

    now: "Nu",
    nowExam: "Nu: læs afsnittet op i ét stræk",
    phoneHint:
      "Sætningen står også på telefonen. Hold knappen, læs op, og slip.",
    keySpace: "Mellemrum",
    keyEsc: "Esc",
    macHintSpace: "starter og stopper optagelsen.",
    macHintEsc: "annullerer.",
    record: "Optag",
    stopRecording: "Stop optagelsen",
    // Run 12: the half second the Mac keeps recording after the stop, then the take is saved.
    savingTake: "Gemmer optagelsen",
    cancelRecording: "Annullér",
    recordingNow: "Optager",
    recordingOnPhone: "Optager på telefonen",
    allDone: "Alle sætninger i denne runde er optaget. Godt arbejde.",
    noCurrent: "Ingen sætning er valgt.",
    pausedHint: "Tryk Fortsæt for at optage videre.",

    listTitle: "Sætningerne",
    filter: "Vis",
    filterAll: (n: string) => `Alle (${n})`,
    filterRedo: (n: string) => `Tag om (${n})`,
    filterWaiting: (n: string) => `Venter (${n})`,
    filterApproved: (n: string) => `Godkendt (${n})`,

    status: {
      waiting: "Venter",
      recording: "Optager",
      received: "Modtaget",
      approved: "Godkendt",
      redo: "Tag om",
    } as Record<string, string>,
    skipped: "Sprunget over",
    current: "Nu",
    take: (n: string, secs: string) => `Optagelse ${n} · ${secs}`,
    approvedByOwner: "Godkendt af dig",
    redoByOwner: "Du bad om en ny optagelse",
    redoByCheck: "Tjekket sendte den tilbage",

    heard: "Edda hørte",
    listening: "Edda lytter",
    waitingForEdda: "Venter på, at Edda lytter",
    eddaError: "Edda lyttede ikke med, så kun lydtjekket afgør.",
    wer: (p: string) => `${p} ordfejl`,
    allRight: "Alle ord rigtige",
    diffLegend: "Forklaring",
    diff: {
      eq: "Samme ord",
      sub: "Hørt som et andet ord",
      del: "Ikke hørt",
      ins: "Ekstra ord",
    },
    srSub: (ref: string, hyp: string) => `${ref}, hørt som ${hyp}`,
    srDel: (ref: string) => `${ref}, ikke hørt`,
    srIns: (hyp: string) => `ekstra ord ${hyp}`,

    play: "Afspil",
    playLabel: (id: string) => `Afspil optagelsen af ${id}`,
    stopPlaying: "Stop",
    redo: "Tag om",
    approveAnyway: "Godkend alligevel",
    go: "Optag nu",
    goLabel: (id: string) => `Gør ${id} til den næste sætning`,

    problems: {
      quiet: "For svag",
      clipped: "Forvrænget",
      cut: "Skåret af",
      silent: "Hørte ikke noget",
      short: "For kort",
      gaps: "Huller i lyden",
      loud: "Kraftig",
      noisy: "Støj i baggrunden",
      mismatch: "Edda hørte noget andet",
      error: "Tjekket fejlede",
    } as Record<string, string>,
    problemOther: (kind: string) => `Andet: ${kind}`,
    // Run 12: what to do about a problem, under the take and on its chip.
    problemHelp: {
      cut: "Ordene rører kanten af optagelsen, så et ord kan være skåret af. Start optagelsen et øjeblik, før du taler, og stop den først et øjeblik efter det sidste ord.",
    } as Record<string, string>,
    checksLabel: "Lydtjekket",
    sendsBack: "Sendt tilbage",
    warning: "Advarsel",

    meter: {
      label: "Lydniveau",
      bands: {
        silent: "Stille",
        tooQuiet: "For svag",
        quiet: "Lidt svag",
        good: "God",
        loud: "Kraftig",
        tooLoud: "For kraftig",
      } satisfies Record<Band, string>,
      verdict: (level: string, band: string) =>
        `${level}, ${band.toLowerCase()}`,
      aria: (level: string, peak: string, noise: string, band: string) =>
        `Lydniveau ${level}, ${band.toLowerCase()}. Top ${peak}. Baggrundsstøj ${noise}.`,
      snr: (snr: string) => `${snr} over støjen`,
      envelope: "Lyden hen over optagelsen",
      pending: "Lyden bliver målt",
    },

    progressTitle: "Fremskridt mod mixet",
    mixTitle: "Det valgte mix",
    progressHelp:
      "Godkendte sætninger af dem, mixet har planlagt for hvert forhold.",
    progressTotal: (minutes: string, sentences: string) =>
      `${minutes} optaget i alt af ${sentences} sætninger`,
    progressShare: (share: string) => `${share} af mixet`,
    progressDone: (done: string, planned: string) => `${done} af ${planned}`,

    pilotTitle: "Piloten",
    pilotSetups: "Opsætningerne",
    pilotCompare: "Sammenlign opsætningerne",
    pilotComparing: "Sammenligner opsætningerne",
    pilotFrom: (when: string) => `Sammenligning fra ${when}`,
    pilotModel: (model: string) => `Model: ${model}`,
    pilotReport: "Åbn hele pilotrapporten",
    pilotFailed: "Sammenligningen fejlede. Se loggen.",
    pilotMetrics: {
      wer: "Ordfejl (WER)",
      werHelp: "Lavere er bedre",
      snr: "Tale over støj",
      snrHelp: "Højere er bedre",
      level: "Taleniveau",
      levelHelp: "Tættere på det gode bånd er bedre",
      clipped: "Forvrængede klip",
      clippedHelp: "Færre er bedre",
    },
    clips: (n: string) => `${n} klip`,

    pilotNotes: "Noter fra sammenligningen",
    empty: {
      all: "Der er ingen sætninger i denne optagelse.",
      redo: "Ingen sætninger skal tages om. Her kommer dem, som tjekket eller du sender tilbage.",
      waiting: "Ingen sætninger venter. Alle i denne runde er optaget.",
      approved:
        "Ingen sætninger er godkendt endnu. Her kommer dem, der består tjekket, når du har optaget dem.",
      progress:
        "Bjælkerne fyldes op, efterhånden som dine optagelser bliver godkendt. Start en optagelse ovenfor.",
      pilot:
        "Her kommer sammenligningen af opsætningerne: ordfejl, tale over støj, niveau og forvrængning.",
      pilotWhen:
        "Den kommer, når du har optaget piloten i mindst én opsætning og trykket Sammenlign opsætningerne.",
    },
  },

  data: {
    title: "Data",
    intro: "Hvad træningen får at se, og hvad der holdes udenfor.",
    config: "Konfiguration",
    sentences: "Sætninger",
    plain: "Uden engelske ord",
    terms: "Med engelske fagord",
    recorded: "Indtalt",
    minutesTitle: "Optagede minutter pr. forhold",
    splitTitle: "Opdeling pr. forhold",
    splitHelp: (validation: string, test: string, config: string) =>
      `Validering ${validation} og test ${test} af sætningerne, som konfigurationen ${config} siger. En sætning ligger altid kun i én af delene.`,
    unit: "Enhed",
    takes: "Optagelser",
    minutes: "Minutter",
    train: "Træning",
    validation: "Validering",
    test: "Test",
    condition: "Forhold",
    total: "I alt",
    skipped: (n: string) => `${n} optagelser er ikke med`,
    skippedHelp:
      "Optagelser, der skal tages om, eller som ikke kan bruges, holdes ude af træningen.",
    rehearsal: (share: string, validation: string) =>
      `Genopfriskning: ${share} af træningen og ${validation} af valideringen er almindelig dansk tale, så modellen ikke glemmer det, den kan i forvejen.`,
    leakageTitle: "Lækagetjek",
    leakageHelp:
      "Ingen sætning må både være i træningen og i det, modellen bliver bedømt på. Ellers ser tallene bedre ud, end de er.",
    leakageNotRun: "Lækagetjekket er ikke kørt endnu.",
    leakageOk: "I orden",
    leakageOverlap: (n: string) => `${n} fælles sætninger`,
    leakageUnknown: "Kunne ikke tjekkes",
    leakageAllOk: "Alle tjek er i orden.",
    leakageSomeUnknown:
      "Ikke alle tjek kunne køres. Ved hvert tjek står hvorfor.",
    leakageProblem:
      "Mindst ét tjek fandt fælles sætninger. Træn ikke, før det er rettet.",
    boxes: {
      train: "Træning",
      validation: "Validering",
      test: "Test",
      "fleurs-test": "FLEURS-testen",
      exam: "Eksamen",
      pilot: "Piloten",
    } as Record<string, string>,
    heldOut: "Holdt udenfor",
    yourSplits: "Dine optagelser",

    empty: {
      what: "Her kommer dine optagelser: minutterne pr. forhold og deres opdeling i træning, validering og test.",
      when: "De kommer efter den første optagelse på Optagelse.",
      go: "Til Optagelse",
      leakage: "Det kører, når der er optagelser at tjekke.",
    },
  },

  training: {
    title: "Træning",
    intro:
      "Vælg en konfiguration, se indstillingerne, og start. Kurverne tegnes, mens den træner.",
    config: "Konfiguration",
    settings: "Indstillinger",
    file: (f: string) => `Fil: ${f}`,
    sections: {
      base_model: "Grundmodel",
      data: "Data",
      training: "Træning",
      lora: "LoRA",
      encoder: "Encoder",
      decoder: "Decoder",
      eval: "Evaluering",
      evaluation: "Evaluering",
      export: "Eksport",
      tracking: "Sporing",
      rehearsal: "Genopfriskning",
      general: "Generelt",
    } as Record<string, string>,
    start: "Start træningen",
    starting: "Starter",
    busy: "Der kører allerede en træning.",
    running: "Træningen kører",
    noRun: "Ingen træning kører. Vælg en konfiguration, og start.",
    phase: {
      build: "Bygger datasættet",
      cache: "Forbereder lyden til encoderen",
      train: "Træner",
      validate: "Validerer",
      done: "Færdig",
      failed: "Fejlede",
      stopped: "Stoppet",
    } as Record<string, string>,
    phases: "Faser",
    epoch: (e: string, n: string) => `Epoke ${e} af ${n}`,
    step: (s: string, n: string) => `Trin ${s} af ${n}`,
    run: (name: string) => `Kørsel: ${name}`,
    awake: "Mac'en holdes vågen, mens træningen kører",
    stop: "Stop træningen",
    stopConfirm: "Stop træningen nu? Den kan ikke fortsætte, hvor den slap.",
    stopYes: "Ja, stop den",
    stopNo: "Lad den køre",
    stopping: "Stopper",
    lossTitle: "Tab under træningen",
    lossHelp:
      "Lavere er bedre. Træningstabet svinger fra trin til trin, så linjen er udglattet. Valideringen er den, der tæller.",
    trainLoss: "Træning, udglattet",
    trainLossRaw: "Træning, hvert trin",
    validationLoss: "Validering",
    werTitle: "Ordfejl på valideringen",
    werHelp: "Epoke 0 er Edda, før træningen begyndte.",
    stepAxis: "Trin",
    noPoints: "Ingen punkter endnu.",
    tooltipStep: (s: string) => `Trin ${s}`,
    runsTitle: "Tidligere træninger",
    colRun: "Kørsel",
    colDate: "Dato",
    colBestEpoch: "Bedste epoke",
    colBest: "Ordfejl, bedste",
    colBaseline: "Ordfejl før",
    colChange: "Forskel",
    done: "Træningen er færdig.",
    best: (epoch: string, wer: string) =>
      `Bedste epoke: ${epoch}, med ${wer} ordfejl på valideringen.`,
    configError: "Konfigurationen kan ikke indlæses, så den kan ikke startes.",
    unfinished: "Ikke færdig",
    byDefault: "standard",
    noAdapter: "Ingen adapter",
    failed: "Træningen fejlede. Se loggen.",
    stopped: "Træningen blev stoppet.",

    essentials: "Start med disse fire",
    essentialsHelp: (file: string) =>
      `Det er dem, du først skal prøve at ændre. Du ændrer dem i ${file}.`,
    allSettings: (n: string) => `Alle indstillinger (${n})`,
    allSettingsHelp:
      "Resten kan blive, som de er, til du ved, hvad du vil ændre.",
    runsEmptyWhat:
      "Her kommer dine træninger med deres bedste epoke og ordfejl.",
    runsEmptyWhen:
      "Den første kommer, når en træning, du har startet ovenfor, er færdig.",
  },

  evaluation: {
    title: "Evaluering",
    intro:
      "Kørslerne fra MLflow. Ordfejl er andelen af ord, modellen skriver forkert; lavere er bedre.",
    colRun: "Kørsel",
    colDate: "Dato",
    colModel: "Model",
    colClips: "Klip",
    colWer: "Ordfejl (WER)",
    colCi: "95 %-interval",
    colCer: "Tegnfejl (CER)",
    colChange: "Ændring",
    colInterval: "Ordfejl med interval",
    scale: (max: string) => `0 til ${max}`,
    open: "Åbn rapport",
    opening: "Laver rapporten",
    openLabel: (name: string) => `Åbn rapporten for ${name}`,
    compareTitle: "Sammenlign to kørsler",
    compareHelp:
      "Vælg kørsel A og kørsel B. Rapporten viser forskellen sætning for sætning.",
    a: "Kørsel A",
    b: "Kørsel B",
    choose: "Vælg en kørsel",
    compare: "Sammenlign",
    comparing: "Sammenligner",
    sameRun: "Vælg to forskellige kørsler.",

    slug: (name: string) => `Navn i MLflow og i terminalen: ${name}`,
    group: (n: string) => `Normalisering ${n}`,
    groupUnknown: "Normalisering uden nummer",
    since: {
      "1": "Før 26. oktober 2026.",
      "2": "Fra 26. oktober 2026. Det er den, der gælder nu.",
    } as Record<string, string>,
    unknownHelp:
      "Målt med en ændret normalisering, der ikke har fået et nummer endnu. Tallene kan ikke sammenlignes med de andre.",
    fixTitle: "Sammenlign kun inden for samme gruppe",
    fixNote:
      "Normaliseringen gør teksten ens, før ordfejlene tælles. Den blev rettet den 26. oktober. Det ændrede alle tallene, uden at modellen blev ændret.",
    mixed:
      "A og B er målt med hver sin normalisering. En del af forskellen kommer derfor fra rettelsen og ikke fra modellen.",
    emptyWhat:
      "Her kommer målingerne af modellerne: ordfejl, tegnfejl og hvor sikre tallene er.",
    emptyWhen:
      "De første kommer, når du har kørt en evaluering i terminalen, for eksempel af Edda på FLEURS:",

    runsTitle: "Målingerne",
    measureTitle: "Mål en model",
    measureHelp:
      "Mål på valideringen, når du sammenligner undervejs. Testsættet gemmer du til den endelige måling.",
    model: "Model",
    build: "Datasæt",
    notBuilt: (name: string) => `${name} (ikke bygget)`,
    buildFirst: "Byg datasættet i terminalen først:",
    skipFleurs: "Spring FLEURS over, så går det hurtigere",
    skipFleursHelp:
      "FLEURS tjekker, at Edda stadig kan almindeligt dansk. Det er den del, der tager længst tid.",
    onValidation: "Mål på valideringen",
    onTest: "Mål på testsættet",
    measuring: "Måler",
    confirmLabel: "Brug testsættet",
    confirmText:
      "Testsættet er til den endelige måling. Hver gang du bruger det, bliver det skrevet ned. Vil du måle på testsættet nu?",
    confirmYes: "Ja, mål på testsættet",
    confirmNo: "Nej, ikke nu",
    measured: "Målingen er færdig. Den står i listen nedenfor.",
    measureFailed: "Målingen fejlede. Se loggen.",
    measureStopped: "Målingen blev stoppet.",
    measureEmptyWhat: "Her kan du måle Edda og dine træninger på valideringen.",
    measureEmptyWhen:
      "Det kan du, når du har trænet en model eller bygget et datasæt, for eksempel sådan:",

    testsetTitle: "Testsættet",
    testsetHelp:
      "Testsættet bruges kun til den endelige måling. Hver brug bliver skrevet ned her.",
    locked: (date: string, sentences: string, clips: string) =>
      `Låst den ${date}: ${sentences} sætninger og ${clips} klip.`,
    lockedUndated: (sentences: string, clips: string) =>
      `Låst: ${sentences} sætninger og ${clips} klip.`,
    lockedFrom: (build: string) => `Fra datasættet ${build}.`,
    notLocked: "Testsættet er ikke låst endnu.",
    used: (n: string) => `Brugt ${n} gange`,
    usedOnce: "Brugt 1 gang",
    unused: "Ikke brugt endnu.",
    usesLabel: "Hver brug af testsættet",
    fromStudio: "fra Værkstedet",
    fromCli: "fra terminalen",

    badgeTest: "Test",
    badgeTestLabel: "Målt på testsættet",
    badgeValidation: "Validering",
    compareShow: "Vis målinger",
    compareValidation: "Validering",
    compareAll: "Alle",
    compareNoValidation:
      "Der er ingen målinger på valideringen endnu. Mål en model ovenfor, eller vis alle målinger.",
  },

  mix: {
    title: "Skift mixet",
    help: "Sæt andelen for hvert forhold. Sætninger, du har optaget, bliver, hvor de er. De andre deles ud igen, præcis som wt-train plan --mix gør.",
    colCondition: "Forhold",
    colShare: "Andel",
    colSentences: "Sætninger",
    colLeft: "Tilbage",
    colPace: "Tempo",
    colTime: "Tid tilbage",
    shareLabel: (label: string) => `Andel for ${label} i procent`,
    total: (p: string) => `I alt ${p}`,
    totalWrong: (p: string) =>
      `Andelene skal give 100 % tilsammen. Nu giver de ${p}.`,
    notWhole: "Skriv et helt tal fra 0 til 100 i hvert felt.",
    pace: (s: string) => `${s} pr. sætning`,
    paceOwn: "dit tempo",
    pacePilot: "pilotens tempo",
    paceHelp:
      "Tiden er sætningerne tilbage gange dit tempo i det forhold. Indtil du har optaget nok, bruges pilotens målte tempo.",
    time: (t: string) => `ca. ${t}`,
    timeTotal: (t: string) => `Ca. ${t} tilbage i alt`,
    moved: (n: string) => `Det flytter ${n} sætninger:`,
    movedOne: "Det flytter 1 sætning:",
    movedNone: "Ingen sætninger flytter.",
    movedPair: (n: string, from: string, to: string) =>
      `${n} fra ${from} til ${to}`,
    unchanged: "Det er det mix, du har nu.",
    deal: "Del ud igen",
    dealing: "Deler ud",
    dealt: (n: string) => `Sætningerne er delt ud igen. ${n} flyttede.`,
    reset: "Fortryd",
    recording: "Stop optagelsen først. Så kan sætningerne deles ud igen.",
    previewing: "Regner efter",
  },

  ownwords: {
    title: "Dine egne ord",
    intro:
      "Engelske ord fra dine egne dikteringer, som stavelisten ikke kender endnu. Sæt flueben ved dem, Edda skal lære.",
    privacy:
      "Værkstedet læser WalkieTalkeys historik på denne Mac uden at ændre den. Kun ordene, og hvor tit du siger dem, bliver vist. Ingen af dine sætninger bliver vist eller gemt.",
    source: (n: string) => `Fundet i ${n} dikteringer.`,
    newTitle: "Nye ord",
    newHelp: "Det, du siger oftest, står øverst.",
    listLabel: "Nye ord at sætte flueben ved",
    times: (n: string) => `${n} gange`,
    once: "1 gang",
    inDictations: (n: string) => `i ${n} dikteringer`,
    inOne: "i 1 diktering",
    share: (p: string) => `${p} af dikteringerne`,
    phrase: "Udtryk",
    more: (n: string) => `Og ${n} mere, som du siger sjældnere.`,
    mineTitle: "Dine ord",
    mineHelp:
      "Ordene med flueben. Skriv gerne nogle sætninger med hvert ord, så kommer de med, når du indtaler.",
    mineLabel: "Ord med flueben",
    untick: "Fjern flueben",
    untickLabel: (w: string) => `Fjern fluebenet ved ${w}`,
    notInHistory: "Ikke i historikken lige nu",
    noSentences: "Ingen sætninger endnu.",
    sentenceLabel: (w: string) => `En sætning med ${w}`,
    add: "Tilføj sætningen",
    adding: "Tilføjer",
    added: "Sætningen er tilføjet.",
    rules:
      "4 til 20 ord, med ordet i, uden tankestreg, og ikke en sætning, der findes i forvejen.",
    files: (words: string, sentences: string) =>
      `Fluebenene gemmes i ${words} og sætningerne i ${sentences}. Git ser ingen af dem.`,
    noHistoryWhat: "Her kommer de engelske ord, du siger, når du dikterer.",
    noHistoryWhen:
      "De kommer, når du har dikteret med WalkieTalkey på denne Mac. Værkstedet leder efter historikken her:",
    unreadable:
      "Historikken kunne ikke læses lige nu. Prøv igen om lidt, eller luk WalkieTalkey et øjeblik.",
    noWordsWhat:
      "Ingen nye engelske ord. Stavelisten kender allerede dem, du siger.",
    noWordsWhen: "Kig forbi igen, når du har dikteret mere.",
    allTicked:
      "Du har sat flueben ved alle ordene. De står under Dine ord nedenfor.",
    mineWhat:
      "Her kommer de ord, du sætter flueben ved, med dine egne sætninger.",
    mineWhen: "Sæt flueben ved et ord ovenfor.",
  },

  report: {
    title: "Rapport",
    back: "Tilbage",
    backTo: (where: string) => `Tilbage til ${where.toLowerCase()}`,
    bad: "Rapporten kan ikke vises.",
    frame: "Rapporten",
  },

  versions: {
    title: "Versioner",
    intro:
      "De modeller, WalkieTalkey kan bruge. Skift med ét klik, og skift tilbage på samme måde.",
    inUse: (name: string) => `Appen bruger nu ${name}`,
    inUseBadge: "I brug",
    base: "Grundmodellen",
    baseName: (name: string) => `${name}, uden finjustering`,
    use: "Brug denne",
    useBase: (name: string) => `Brug ${name}`,
    using: "Skifter",
    switched: (name: string) => `WalkieTalkey bruger nu ${name}.`,
    notInstalled: "Ikke installeret",
    appMissing:
      "WalkieTalkey er ikke fundet på denne Mac. Valget gemmes til appen starter.",
    appCannot:
      "Denne version af WalkieTalkey kan ikke skifte model fra Værkstedet. Opdatér appen.",
    colVersion: "Version",
    colRun: "Træning",
    colDate: "Dato",
    colWer: "Ordfejl på valideringen",
    versionN: (n: string) => `Version ${n}`,
    exportTitle: "Eksportér en træning",
    exportHelp:
      "Laver en model, appen kan bruge, ud fra en færdig træning. Den lægges i listen ovenfor.",
    exportRun: "Træning",
    export: "Eksportér",
    exporting: "Eksporterer",
    exported: "Eksporteret. Den nye version står i listen.",
    exportFailed: "Eksporten fejlede. Se loggen.",
    exportStopped: "Eksporten blev stoppet.",

    emptyWhat: "Her kommer dine finjusterede versioner af Edda.",
    emptyWhen:
      "Den første kommer, når du har eksporteret en færdig træning nedenfor.",
    exportEmptyWhat: "Her kommer de træninger, der kan eksporteres.",
    exportEmptyWhen:
      "De kommer, når en træning på Træning er færdig og har gemt en adapter.",
    goTraining: "Til Træning",
  },

  journal: {
    title: "Journal",
    intro:
      "En side pr. kørsel: tallene skrives ind af sig selv, og du skriver, hvad du forventede, og hvad du lærte.",
    pages: "Sider",
    runs: "Kørsler uden side",
    runsEmpty: "Alle kørsler har en side.",
    write: "Skriv side",
    writing: "Skriver siden",
    hasHypothesis: "Hypotese skrevet",
    noHypothesis: "Ingen hypotese endnu",
    hasLearned: "Læring skrevet",
    noLearned: "Intet lært skrevet endnu",
    allPages: "Alle sider",
    hypothesis: "Hypotese",
    hypothesisHelp: "Hvad forventede du, og hvorfor?",
    learned: "Hvad jeg lærte",
    learnedHelp: "Hvad viste tallene, og hvad prøver du næste gang?",
    notesTitle: "Dine noter",
    save: "Gem",
    saving: "Gemmer",
    saved: "Gemt",
    unsaved: "Ikke gemt",
    leave: "Du har tekst, der ikke er gemt. Vil du forlade siden alligevel?",
    kindTrain: "Træning",
    kindEval: "Evaluering",

    pagesEmptyWhat: "Her kommer en side pr. kørsel med tallene og dine noter.",
    pagesEmptyWhen: "Skriv den første ud fra en kørsel nedenfor.",
    pagesEmptyNoRuns:
      "Den første kan du skrive, når du har trænet eller evalueret en model.",
    runsNoneWhat: "Her kommer dine kørsler fra MLflow.",
    runsNoneWhen: "De kommer, når du har trænet eller evalueret en model.",
  },

  notFound: {
    title: "Siden findes ikke",
    body: "Den side kender Værkstedet ikke.",
    home: "Til optagelsen",
  },

  learn: {
    title: "Lær det",
    intro:
      "Fem små notesbøger om, hvordan Edda hører, hvordan den måles, og hvordan den finjusteres. Kør dem fra toppen i VS Code.",
    setup:
      "VS Code skal have udvidelserne Python og Jupyter. Spørger den efter en kerne, så vælg .venv i training.",
    copies: (folder: string) =>
      `Hver notesbog åbner som din egen kopi i ${folder}. Den originale ændrer sig aldrig.`,
    listLabel: "Notesbøgerne",
    minutes: (n: string) => `ca. ${n} min`,
    open: "Åbn i VS Code",
    opening: "Åbner",
    openLabel: (title: string) => `Åbn ${title} i VS Code`,
    opened: "Åbnet i VS Code.",
    openedNew: "Åbnet i VS Code som din egen kopi.",
    notOpened: "Ikke åbnet endnu",
    saved: (when: string) => `Din kopi, gemt ${when}`,
    ran: "Kørt",
    notRun: "Ikke kørt endnu",
    reset: "Start forfra",
    resetLabel: (title: string) => `Start ${title} forfra`,
    resetConfirm:
      "Start forfra? Din kopi med dine ændringer og resultater lægges til side, og du får den originale notesbog igen.",
    resetYes: "Ja, start forfra",
    resetNo: "Behold min kopi",
    resetting: "Starter forfra",
    resetDone: "Startet forfra med den originale notesbog.",
    emptyWhat: "Her kommer notesbøgerne, der viser dig, hvordan Edda virker.",
    emptyWhen: "De kommer, når de ligger i training/notebooks.",
  },
};

export type Strings = typeof S;

export type ErrorArea =
  | "recording"
  | "pilot"
  | "data"
  | "training"
  | "evaluation"
  | "versions"
  | "journal"
  | "learn"
  | "measure"
  | "mix"
  | "ownwords";

/** The Danish text for an error code (API.md: the page names each code itself), by route. */
export function errorText(
  code: string | null | undefined,
  area?: ErrorArea,
): string {
  if (!code) return S.errors.generic;
  return (
    (area && S.errorsIn[area]?.[code]) || S.errors[code] || S.errors.generic
  );
}
