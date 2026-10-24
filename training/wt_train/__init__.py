"""WalkieTalkey fine-tuning workbench.

Tools for teaching Edda (danish-foundation-models/edda-v0.2) English developer
terms inside Danish speech without losing plain Danish. One command,
``wt-train``, with a subcommand per step (``wt-train --help`` lists them):

    record   wt_train.recorder   read sentences aloud, one take per sentence
    fetch    wt_train.fleurs     FLEURS da_dk train and test (rehearsal, regression)
    build    wt_train.dataset    train/validation/test splits by sentence
    train    wt_train.train      LoRA on Edda, one YAML config per experiment
    eval     wt_train.evaluate   WER, CER and English-term accuracy -> results.csv
    export   wt_train.export     merge, GGUF Q8_0, same-text check, install in the app
    smoke    wt_train.smoke      the whole chain on 20 FLEURS clips, then cleaned up

Recordings stay in training/data/recordings/ (git-ignored, never uploaded).
"""
