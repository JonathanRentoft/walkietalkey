#!/usr/bin/env bash
# Build the Danish speed clips from FLEURS da_dk test (google/fleurs, CC BY 4.0)
# as 16 kHz mono PCM16 WAV of exact length (zero-padded or trimmed):
#
#   da-fleurs-10s.wav  one FLEURS utterance, 9.96 s padded to 10.000 s. Bundled with
#                      the app for the DESK-31 speed check; committed in models/clips/.
#   da-fleurs-11s.wav  one utterance, 10.98 s padded to 11.000 s (cf. transcribe.cpp's jfk, 11.0 s).
#   da-fleurs-30s.wav  three utterances back to back, 30.000 s (exactly one Whisper window).
#   da-fleurs-35s.wav  four utterances back to back, 35.000 s (two windows; cf. dots, 35.3 s).
#
# Usage: models/clips/make_clips.sh <fleurs-da_dk-dir> <out-dir>
set -euo pipefail

FLEURS="${1:?usage: $0 <fleurs-da_dk-dir> <out-dir>}"
OUT="${2:?usage: $0 <fleurs-da_dk-dir> <out-dir>}"
mkdir -p "$OUT"
A="$FLEURS/test/6263195548503774343.wav"    # "Længere nordpå er der store områder, ..." (9.96 s)
B="$FLEURS/test/17924706686437869147.wav"   # "Kreativitet og opfindsomhed begynder ..." (10.98 s)
C="$FLEURS/test/9971881831427759748.wav"    # "Stilladsering er en ikke en læringsmetode, ..." (9.96 s)
D="$FLEURS/test/12533154434361194704.wav"   # "I 1990 blev det tilføjet listen ..." (10.02 s)

# exact <seconds> <out> <inputs...>: concatenate, resample-safe, pad/trim to the exact length.
exact() {
  local secs="$1" out="$2"; shift 2
  local inputs=() n=0
  for f in "$@"; do inputs+=(-i "$f"); n=$((n + 1)); done
  local filter=""
  for ((i = 0; i < n; i++)); do filter+="[$i:a]"; done
  filter+="concat=n=$n:v=0:a=1,aresample=16000,apad=whole_dur=${secs},atrim=end=${secs}[out]"
  ffmpeg -nostdin -loglevel error -y "${inputs[@]}" -filter_complex "$filter" -map "[out]" \
    -ac 1 -ar 16000 -c:a pcm_s16le -bitexact -map_metadata -1 "$out"
}

exact 10 "$OUT/da-fleurs-10s.wav" "$A"
exact 11 "$OUT/da-fleurs-11s.wav" "$B"
exact 30 "$OUT/da-fleurs-30s.wav" "$A" "$B" "$C"
exact 35 "$OUT/da-fleurs-35s.wav" "$A" "$B" "$C" "$D"
ls -l "$OUT"/da-fleurs-*.wav
