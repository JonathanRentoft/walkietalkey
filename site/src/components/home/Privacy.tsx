import { LightWaves, ShowcaseCard } from "@walkietalkey/ui";
import { Check } from "./Icons";

/** The privacy section of ForsideKomplet: LightWaves (the page's one WebGL surface) under the text, with the
    "lokal" scene. One island, so the waves and the scene hydrate together when the section comes into view. */
export default function Privacy() {
  return (
    <LightWaves className="privacy-in" palette="morgengry" lift={-0.33} intensity={0.85}>
      <div>
        <p className="eyebrow">Privatliv</p>
        <h2 className="h2">Din stemme forlader aldrig dine egne enheder ukrypteret.</h2>
        <p className="lead">Ingen sky lytter med. Talemodellen kører på din computer, og vejen fra telefonen er krypteret hele vejen.</p>
        <ul className="facts">
          <li><Check s={16} /><div>Transskriberingen sker lokalt. <span>Lyden bliver ikke gemt.</span></div></li>
          <li><Check s={16} /><div>Ingen konto og ingen sporing. <span>Vi ved ikke, hvem du er.</span></div></li>
          <li><Check s={16} /><div>Oprydning med AI er valgfri. <span>Bruger du din egen nøgle, kan du se præcis, hvad der sendes.</span></div></li>
        </ul>
      </div>
      <ShowcaseCard scene="lokal" surface="motion" palette="nat" ratio="5 / 4" />
    </LightWaves>
  );
}
