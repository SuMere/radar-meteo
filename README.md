# Radar Meteo

Radar meteo di qualsiasi luogo, con scelta automatica della fonte migliore e
navigazione di ±15 giorni nel tempo.

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
| NOAA NEXRAD (IEM) | radar, 1 km, 5 min | USA | archivio (usati 15 g) | – |
| RainViewer | mosaico radar mondiale, 10 min | dove esistono radar (verificato con la loro mappa di copertura) | 2 h | – |
| EUMETSAT H SAF H60B / H63 | satellite, ~4 km, 15 min | Europa, Africa / Asia, Oceano Indiano | anni (usati 15 g) | – |
| NASA GPM IMERG | satellite, ~10 km, 30 min | globale ±60° | mesi (usati 15 g, ritardo ~6 h) | – |
| Open-Meteo (best match) | modelli numerici, orario | globale | 15 giorni (analisi) | 16 giorni |

Nessun servizio gratuito offre radar *osservato* per 15 giorni ovunque: per il
passato remoto l'app usa radar dove c'è archivio (USA, Germania), altrimenti
stime da satellite; per il futuro solo i modelli (che a lungo termine sono
indicativi). Il tipo di dato mostrato (osservato / nowcast / analisi / previsione)
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

## Vento e UV

Il menu **Dato** passa da pioggia a **vento** (velocità a 10 m in colore e particelle
animate che seguono il flusso; frecce statiche se il sistema chiede di ridurre le animazioni) o **indice UV** (scala colori OMS). Questi dati
esistono solo come modello (Open-Meteo), quindi in quelle modalità la fonte è
sempre il modello, orario, per ±15 giorni. Sotto l'orario sono sempre indicati,
per il centro della mappa, pioggia, vento (con direzione e raffiche) e indice UV
con la categoria di esposizione, il consiglio di protezione (al passaggio del
mouse) e il picco UV del giorno.

## Comandi

- slider/timeline: trascina o clicca; la timeline mostra la disponibilità di
  ogni fonte e la pioggia oraria prevista/stimata al centro della mappa
- **Vai a**: scegli data e ora precise (ora locale, entro ±15 giorni) e premi
  **Vai** o `Invio`
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
