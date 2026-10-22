# Radar Meteo

Radar meteo di qualsiasi luogo, con scelta automatica della fonte migliore e
navigazione nel tempo dal 1° gennaio 1940 a +15 giorni.

## Avvio

```sh
python3 serve.py          # apre http://127.0.0.1:8765/ nel browser
python3 serve.py 9000     # porta diversa
python3 serve.py --no-browser
```

Non installa nulla: usa solo Python 3 (libreria standard) e il browser.
Per chiudere: `Ctrl+C`. Per rimuovere l'app basta cancellare la cartella
(più, se vuoi, i dati del sito `127.0.0.1:8765` dal browser: preferenze e storico rating).

### Su un server di casa (raggiungibile dalla LAN)

```sh
git clone https://github.com/<utente>/radar-meteo.git
cd radar-meteo
python3 serve.py --host 0.0.0.0 --port 8765 --no-browser
```

Poi apri `http://<ip-del-server>:8765/` da qualsiasi dispositivo della rete.
Il server serve solo file statici in lettura; non esporlo su Internet senza un
reverse proxy HTTPS. Via HTTP in LAN il pulsante 📍 non funziona (i browser
concedono la geolocalizzazione solo su HTTPS o 127.0.0.1): usa la ricerca.

Sul UDOO lo script `udoo-setup.sh` (voce **R**) clona il repository in
`/opt/radar-meteo` e lo avvia come servizio systemd isolato (`radar-meteo.service`,
utente dinamico senza privilegi, filesystem in sola lettura).

### Online con GitHub Pages

L'app è statica, quindi funziona anche da GitHub Pages
(Settings → Pages → Deploy from a branch → `main` / root):
`https://sumere.github.io/radar-meteo/`. Su HTTPS funziona anche il pulsante 📍.

## Fonti

| Fonte | Tipo | Copertura | Passato | Futuro |
|---|---|---|---|---|
| DWD RADOLAN | radar, 1 km, 5 min | Germania e confinanti | ~3,5 giorni | nowcast 2 h |
| NOAA NEXRAD (IEM) | radar, 1 km, 5 min | USA | dal 1995 (N0R, poi N0Q da nov 2010) | – |
| RainViewer | mosaico radar mondiale, 10 min | dove esistono radar (verificato con la loro mappa di copertura) | 2 h | – |
| EUMETSAT H SAF H60B / H63 | satellite, ~4 km, 15 min | Europa, Africa / Asia, Oceano Indiano | da dic 2022 | – |
| NASA GPM IMERG | satellite, ~10 km, 30 min | globale ±60° | dal 1998 (ritardo ~6 h) | – |
| Open-Meteo (best match) | modelli numerici, orario | globale | ~3 mesi (analisi), dal 23/03/2021 (archivio delle previsioni), dal 1940 (rianalisi ERA5, ~25 km) | 16 giorni |

Nessun servizio gratuito offre radar *osservato* ovunque e per decenni: per il
passato remoto l'app usa radar dove c'è archivio (USA), altrimenti stime da
satellite (dal 1998) e prima ancora la rianalisi ERA5; per il futuro solo i
modelli (che a lungo termine sono indicativi). L'indice UV esiste solo dal
23/03/2021. Il tipo di dato mostrato (osservato / nowcast / analisi / previsione)
è sempre indicato sotto l'orario.

## Rating

Ogni 5 minuti l'app sonda tutte le fonti (metadati e ultimo dato disponibile) e
ricalcola un punteggio 0–100:

- tipo di dato (radar > satellite > modello) 35%
- affidabilità misurata (media mobile dei successi, salvata tra le sessioni) 25%
- risoluzione spaziale 12% · freschezza dell'ultimo dato rispetto alla latenza attesa 12%
- frequenza temporale 8% · tempo di risposta 5% · completezza della serie 3%

Per ogni istante viene mostrata la fonte con il punteggio migliore che ha dati
per quell'istante e copre il centro della mappa (mirino). Il nowcast e le
previsioni lontane sono penalizzati. Il pannello **★ Fonti** mostra i rating,
lo storico delle sonde e permette di escludere fonti; il menu **Fonte** forza
una fonte specifica.

## Vento, UV e temperatura

Il menu **Dato** passa da pioggia a **vento** (velocità a 10 m in colore e particelle
animate che seguono il flusso; frecce statiche se il sistema chiede di ridurre le animazioni) o **indice UV** (scala colori OMS, con bagliori animati più fitti e grandi dove l'UV è più alto) o **temperatura** a 2 m (colori e valori in °C sulla mappa). Questi dati
esistono solo come modello (Open-Meteo), quindi in quelle modalità la fonte è
sempre il modello, orario, dal 1940 (UV dal 2021) a +15 giorni. Sotto l'orario sono sempre indicati,
per il centro della mappa, temperatura, pioggia, vento (con direzione e raffiche) e indice UV
con la categoria di esposizione, il consiglio di protezione (al passaggio del
mouse) e il picco UV del giorno.

## Riepilogo previsioni

In alto a destra sulla mappa c'è un riquadro **Previsioni**, che si apre e si chiude
con un clic (chiuso di default sui telefoni). Anche chiuso mostra la temperatura minima
e massima del giorno nella zona visibile. Aperto mostra la minima e la massima nella
zona visibile, sia per l'ora selezionata sia per l'intera giornata (dalla griglia del
modello), e 7 giorni di previsione al centro della mappa: tempo prevalente, minima e
massima, pioggia totale e vento massimo. Un clic su un giorno porta a mezzogiorno di
quel giorno. Con la pioggia da radar la griglia del modello serve solo al riquadro:
viene caricata solo se il riquadro è aperto.

## Comandi

- slider/timeline: trascina o clicca; la timeline mostra 30 giorni, la disponibilità di
  ogni fonte e la pioggia oraria prevista/stimata al centro della mappa. Andando oltre
  i bordi (con −1g, −30g, le frecce, la riproduzione o **Vai a**) la finestra si sposta;
  lontano da oggi in alto a destra compaiono mese e anno
- **Vai a**: scegli data e ora precise (ora locale, dal 1940 a +15 giorni) e premi
  **Vai** o `Invio`; **⇤** porta al dato più vecchio (1° gennaio 1940)
- **−30g** / **+30g** (solo su schermi larghi): salta di un mese
- `←` `→` frame precedente/successivo, `Maiusc+←/→` ±1 ora, `spazio` play/pausa
- **⟲ 2h**: animazione in loop delle ultime 2 ore · **● Adesso**: segue l'ultimo dato in tempo reale

## Sicurezza

- Nessuna installazione, nessuna dipendenza esterna a runtime: Leaflet 1.9.4 è
  incluso in `vendor/` e verificato con hash SRI.
- Il server ascolta solo su `127.0.0.1`, serve solo i file dell'app (allowlist),
  solo GET/HEAD, con header di sicurezza (CSP, nosniff, no frame, ecc.).
- Content-Security-Policy rigida: script solo locali, connessioni solo verso
  gli host delle fonti dichiarate, niente `eval`/script inline.
- Tutte le richieste passano da un'allowlist di host, senza cookie
  (`credentials: omit`), con timeout e limite di dimensione; i dati ricevuti
  vengono validati e mai inseriti come HTML.
- Nessun account, nessuna API key, nessun dato personale inviato (la posizione
  GPS è usata solo se premi 📍, e resta nel browser).
