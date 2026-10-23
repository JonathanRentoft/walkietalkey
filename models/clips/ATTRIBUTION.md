# Bundled speed clip

`da-fleurs-10s.wav` is the clip the app transcribes after the model download to
pick the default model by measured speed (DESK-31). `da-fleurs-10s.txt` is its
reference transcript.

|           |                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source    | FLEURS (Conneau et al., 2022, "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech"), Hugging Face dataset `google/fleurs`, config `da_dk`, split `test`, revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd` |
| Utterance | `6263195548503774343.wav`, sentence id 1741                                                                                                                                                                                           |
| Licence   | Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/                                                                                                                              |
| Changes   | Converted from 32-bit float to 16-bit PCM (16 kHz, mono) and padded with 0.04 s of silence to exactly 10.000 s. Reproduce with `models/clips/make_clips.sh`.                                                                          |
| SHA-256   | `9a6035015e525b809646f53554af20757bee4f3892703de8b13505d1ccb52984`                                                                                                                                                                    |

Credit line for the app's licence screen and NOTICE: "Speed test clip from
FLEURS (Google), CC BY 4.0, padded to 10 s."
