#!/usr/bin/env python3
"""Generates the managed-settings templates from one table (spec Appendix B,
DESK-102, OSS-26): deploy/windows/WalkieTalkey.admx, the en-US and da-DK ADML
files, and the sample macOS profile deploy/macos/com.walkietalkey.app.mobileconfig.
Run from the repository root after changing the table: python3 deploy/windows/generate.py
"""
import plistlib
import uuid
from pathlib import Path
from xml.sax.saxutils import escape

KEY = r"SOFTWARE\Policies\WalkieTalkey"
# (name, kind, choices or None, en label, en explain, da label, da explain)
P = [
 ("RelayUrl", "text", None, "Relay URL", "Your own relay (wss:// only). Default: wss://relay.walkietalkey.com.", "Relæ-adresse", "Jeres eget relæ (kun wss://). Standard: wss://relay.walkietalkey.com."),
 ("PhoneAppUrl", "text", None, "Phone app URL", "Your own copy of the phone app (https://), used in the pairing QR code.", "Telefonappens adresse", "Jeres egen kopi af telefonappen (https://). Bruges i QR-koden ved parring."),
 ("ModelBaseUrl", "text", None, "Model server URL", "Your own model server (https://) with the same file names and SHA-256 sums: files are fetched from <URL>/<file name>.", "Modelserver", "Jeres egen modelserver (https://) med de samme filnavne og SHA-256-summer: filerne hentes fra <adresse>/<filnavn>."),
 ("AllowPhonePairing", "bool", None, "Allow phone pairing", "Disabled turns the phone feature off.", "Tillad parring af telefoner", "Slået fra slukker telefonfunktionen."),
 ("CleanupMode", "enum", [("off","Off","Fra"),("when-needed","When there is something to fix","Når der er noget at rette"),("always","Always","Altid"),("shift","Only while Shift is held","Kun når jeg holder Shift med")], "AI cleanup mode", "The AI cleanup mode (Ryd op med AI).", "Ryd op med AI", "Tilstanden for oprydning med AI."),
 ("CleanupProvider", "enum", [("apple","Apple Intelligence","Apple Intelligence"),("openai","OpenAI","OpenAI"),("anthropic","Anthropic","Anthropic"),("groq","Groq","Groq"),("cerebras","Cerebras","Cerebras"),("openrouter","OpenRouter","OpenRouter"),("custom","Custom (OpenAI-compatible)","Anden (OpenAI-kompatibel)")], "AI cleanup provider", "Forces the cleanup provider. With a managed provider no consent prompt is shown.", "Udbyder til oprydning", "Låser udbyderen til oprydning. Med en låst udbyder vises ingen spørgsmål om samtykke."),
 ("AllowCloudCleanup", "bool", None, "Allow cloud cleanup", "Disabled allows only on-device cleanup (Apple Intelligence, or a custom endpoint on localhost).", "Tillad oprydning i skyen", "Slået fra tillader kun oprydning på computeren (Apple Intelligence eller et endpoint på localhost)."),
 ("CleanupBaseUrl", "text", None, "AI cleanup endpoint", "For example a company Azure OpenAI deployment (https://).", "Endpoint til oprydning", "For eksempel jeres Azure OpenAI-installation (https://)."),
 ("CleanupModel", "text", None, "AI cleanup model", "The model name at the provider.", "Model til oprydning", "Modellens navn hos udbyderen."),
 ("CleanupApiKey", "text", None, "AI cleanup API key", "Read at every start and never copied elsewhere. Policy values can be read by every local user: use a key made for this purpose, with a spending limit.", "API-nøgle til oprydning", "Læses ved hver start og kopieres aldrig andre steder hen. Værdien kan læses af alle lokale brugere: brug en nøgle lavet til formålet, med en udgiftsgrænse."),
 ("VocabularySource", "text", None, "Shared word list", "A file path or an https:// URL with one word per line, refreshed daily.", "Fælles ordliste", "En filsti eller en https://-adresse med ét ord pr. linje. Hentes igen hver dag."),
 ("OutputMode", "enum", [("paste","Paste automatically","Indsæt automatisk"),("clipboard","Clipboard only","Kun udklipsholder")], "Output for key dictations", "Paste at the cursor, or only put the text on the clipboard.", "Output for dikteringer med tasten", "Indsæt ved markøren, eller læg kun teksten på udklipsholderen."),
 ("ShowTextInNotifications", "bool", None, "Show text in notifications", "Disabled hides the text on shared screens.", "Vis teksten i notifikationen", "Slået fra skjuler teksten på delte skærme."),
 ("HistoryRetentionDays", "enum", [("0","Do not keep","Gem ikke"),("1","1 day","1 dag"),("14","14 days","14 dage"),("90","90 days","90 dage"),("4294967295","Always","Altid")], "History retention", "How long dictations are kept on the computer.", "Opbevaring af historik", "Hvor længe dikteringer gemmes på computeren."),
 ("AutoUpdate", "bool", None, "Automatic updates", "Disabled turns update checks off; install updates yourself.", "Automatiske opdateringer", "Slået fra stopper søgning efter opdateringer; I installerer selv."),
 ("UpdateChannel", "enum", [("stable","Stable","Stabil"),("beta","Beta","Beta")], "Update channel", "Stable or beta.", "Opdateringskanal", "Stabil eller beta."),
 ("Model", "text", None, "Speech model", "Pins a model id, for example walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf.", "Talemodel", "Låser en model, for eksempel walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf."),
]


def admx() -> str:
    out = ['<?xml version="1.0" encoding="utf-8"?>',
           '<!-- Generated by deploy/windows/generate.py from one table; WalkieTalkey managed settings (spec Appendix B). -->',
           '<policyDefinitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">',
           '  <policyNamespaces>',
           '    <target prefix="walkietalkey" namespace="WalkieTalkey.Policies.WalkieTalkey" />',
           '    <using prefix="windows" namespace="Microsoft.Policies.Windows" />',
           '  </policyNamespaces>',
           '  <resources minRequiredRevision="1.0" />',
           '  <supportedOn>',
           '    <definitions>',
           '      <definition name="SUPPORTED_WalkieTalkey" displayName="$(string.SUPPORTED_WalkieTalkey)" />',
           '    </definitions>',
           '  </supportedOn>',
           '  <categories>',
           '    <category name="WalkieTalkey" displayName="$(string.WalkieTalkey)" />',
           '  </categories>',
           '  <policies>']
    for name, kind, choices, *_ in P:
        head = f'    <policy name="{name}" class="Machine" displayName="$(string.{name})" explainText="$(string.{name}_Explain)" key="{KEY}"'
        common = ['      <parentCategory ref="WalkieTalkey" />', '      <supportedOn ref="SUPPORTED_WalkieTalkey" />']
        if kind == "bool":
            out += [head + f' valueName="{name}">', *common,
                    '      <enabledValue><decimal value="1" /></enabledValue>',
                    '      <disabledValue><decimal value="0" /></disabledValue>',
                    '    </policy>']
        elif kind == "text":
            out += [head + f' presentation="$(presentation.{name})">', *common,
                    '      <elements>',
                    f'        <text id="{name}" valueName="{name}" required="true" maxLength="2048" />',
                    '      </elements>', '    </policy>']
        else:
            numeric = name == "HistoryRetentionDays"
            items = []
            for value, _en, _da in choices:
                v = f'<decimal value="{value}" />' if numeric else f'<string>{escape(value)}</string>'
                items.append(f'          <item displayName="$(string.{name}_{value.replace("-", "_")})"><value>{v}</value></item>')
            out += [head + f' presentation="$(presentation.{name})">', *common,
                    '      <elements>', f'        <enum id="{name}" valueName="{name}" required="true">', *items,
                    '        </enum>', '      </elements>', '    </policy>']
    out += ['  </policies>', '</policyDefinitions>', '']
    return "\n".join(out)


def adml(idx_label: int, idx_explain: int, supported: str, choice_idx: int) -> str:
    out = ['<?xml version="1.0" encoding="utf-8"?>',
           '<!-- Generated by deploy/windows/generate.py. -->',
           '<policyDefinitionResources xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">',
           '  <displayName>WalkieTalkey</displayName>', '  <description>WalkieTalkey</description>',
           '  <resources>', '    <stringTable>',
           '      <string id="WalkieTalkey">WalkieTalkey</string>',
           f'      <string id="SUPPORTED_WalkieTalkey">{escape(supported)}</string>']
    for row in P:
        name, choices = row[0], row[2]
        out.append(f'      <string id="{name}">{escape(row[idx_label])}</string>')
        out.append(f'      <string id="{name}_Explain">{escape(row[idx_explain])}</string>')
        for c in choices or []:
            out.append(f'      <string id="{name}_{c[0].replace("-", "_")}">{escape(c[choice_idx])}</string>')
    out += ['    </stringTable>', '    <presentationTable>']
    for row in P:
        name, kind = row[0], row[1]
        if kind == "text":
            out.append(f'      <presentation id="{name}"><textBox refId="{name}"><label>{escape(row[idx_label])}</label></textBox></presentation>')
        elif kind == "enum":
            out.append(f'      <presentation id="{name}"><dropdownList refId="{name}" noSort="true">{escape(row[idx_label])}</dropdownList></presentation>')
    out += ['    </presentationTable>', '  </resources>', '</policyDefinitionResources>', '']
    return "\n".join(out)


SAMPLE = {
    "RelayUrl": "wss://relay.example.com",
    "PhoneAppUrl": "https://diktat.example.com",
    "ModelBaseUrl": "https://models.example.com/walkietalkey",
    "AllowPhonePairing": True,
    "CleanupMode": "when-needed",
    "CleanupProvider": "custom",
    "AllowCloudCleanup": True,
    "CleanupBaseUrl": "https://example.openai.azure.com/openai/v1",
    "CleanupModel": "gpt-4o-mini",
    "VocabularySource": "https://intranet.example.com/walkietalkey/ord.txt",
    "OutputMode": "paste",
    "ShowTextInNotifications": True,
    "HistoryRetentionDays": 14,
    "AutoUpdate": True,
    "UpdateChannel": "stable",
}


def mobileconfig() -> dict:
    payload = dict(SAMPLE)
    payload.update({
        "PayloadType": "com.walkietalkey.app",
        "PayloadIdentifier": "com.example.walkietalkey.settings",
        "PayloadUUID": str(uuid.UUID("6f1c2a54-3c55-4d7e-9a1b-7d2f0e8b4c11")),
        "PayloadVersion": 1,
        "PayloadDisplayName": "WalkieTalkey",
    })
    return {
        "PayloadContent": [payload],
        "PayloadDescription": "Sample WalkieTalkey settings. Remove the keys you do not want to manage; every key in this profile is locked in the app. CleanupApiKey is left out on purpose: profile values can be read by every local user.",
        "PayloadDisplayName": "WalkieTalkey (eksempel)",
        "PayloadIdentifier": "com.example.walkietalkey",
        "PayloadOrganization": "Example A/S",
        "PayloadScope": "System",
        "PayloadType": "Configuration",
        "PayloadUUID": str(uuid.UUID("0b0a3f52-8d43-4a5e-bd9e-2c6f3d1a7e90")),
        "PayloadVersion": 1,
    }


def main() -> None:
    Path("deploy/windows/WalkieTalkey.admx").write_text(admx(), encoding="utf-8")
    Path("deploy/windows/en-US/WalkieTalkey.adml").write_text(adml(3, 4, "WalkieTalkey 0.1 or newer", 1), encoding="utf-8")
    Path("deploy/windows/da-DK/WalkieTalkey.adml").write_text(adml(5, 6, "WalkieTalkey 0.1 eller nyere", 2), encoding="utf-8")
    with open("deploy/macos/com.walkietalkey.app.mobileconfig", "wb") as f:
        plistlib.dump(mobileconfig(), f)


if __name__ == "__main__":
    main()
