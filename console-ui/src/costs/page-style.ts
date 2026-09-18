/**
 * The costs page stylesheet, expressed from the repository's token table.
 *
 * It travels with the page module rather than as a build artifact: the console
 * is mounted by whatever process holds the central store, and a screen that
 * only exists after somebody ran a build is a screen missing on the machine
 * that needs it. Every colour, size, radius and gap below is a token value; a
 * value that is not in the table is not defined here.
 */
export const COSTS_PAGE_STYLE = `
:root{
  --color-page:#f4f7fa;--color-surface:#ffffff;--color-text:#172b3a;--color-text-muted:#526477;
  --color-border:#cbd5df;--color-action:#173f63;--color-danger:#b42318;--color-focus:#0b6bcb;
  --color-surface-selected:#e9f1f8;
  --space-inline-tight:4px;--space-control-gap:8px;--space-content-gap:12px;--space-section-gap:20px;
  --space-page-gutter:28px;--space-page-gutter-mobile:16px;
  --font-interface:"IBM Plex Sans","Segoe UI",sans-serif;--font-numeric:"IBM Plex Mono","SFMono-Regular",monospace;
  --font-caption:12px;--font-body:14px;--font-body-large:16px;--font-heading-small:18px;
  --font-heading-page:26px;--font-metric:30px;
  --weight-regular:400;--weight-medium:550;--weight-strong:700;
  --radius-control:6px;--radius-panel:10px;--radius-pill:999px;
  --shadow-raised:0 2px 8px #172b3a14;--layer-sticky:10;--layer-navigation:20;
}
*{box-sizing:border-box}
html{background:var(--color-page);color:var(--color-text);font-family:var(--font-interface);font-size:var(--font-body);line-height:1.5}
body{margin:0;min-width:320px}
a{color:var(--color-action);text-underline-offset:3px}
a[href]{display:inline-flex;align-items:center;min-width:44px;min-height:44px}
button,input,select{font:inherit;color:inherit}
button,.button{min-height:44px;min-width:44px;border:1px solid var(--color-action);border-radius:var(--radius-control);background:var(--color-action);color:var(--color-surface);font-weight:var(--weight-medium);padding:10px 16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-control-gap);text-decoration:none}
button:hover,.button:hover{filter:brightness(.94)}
.button.secondary{background:var(--color-surface);color:var(--color-action);border-color:var(--color-border)}
:focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}
select{width:100%;min-height:44px;border:1px solid var(--color-border);border-radius:var(--radius-control);background-color:var(--color-surface);padding:9px 11px;box-shadow:0 1px 0 var(--color-page);appearance:none;-webkit-appearance:none;padding-right:40px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--color-text-muted) 50%),linear-gradient(135deg,var(--color-text-muted) 50%,transparent 50%),linear-gradient(to right,var(--color-border),var(--color-border));background-position:calc(100% - 17px) 19px,calc(100% - 12px) 19px,calc(100% - 36px) 0;background-size:5px 5px,5px 5px,1px 100%;background-repeat:no-repeat}
select:hover{border-color:var(--color-text-muted)}
select:focus-visible{border-color:var(--color-focus)}
label{display:block;font-weight:var(--weight-medium);margin-bottom:var(--space-inline-tight)}
h1{font-size:var(--font-heading-page);line-height:1.2;margin:0 0 5px}
h2{font-size:var(--font-heading-small);margin:0}
p{max-width:76ch;margin:0}
.shell{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;background:var(--color-surface);border-right:1px solid var(--color-border);padding:24px 16px;z-index:var(--layer-sticky)}
.brand{font-size:var(--font-heading-small);font-weight:var(--weight-strong);padding:0 12px 18px}
.brand small{display:block;color:var(--color-text-muted);font-size:var(--font-caption);font-weight:var(--weight-regular);margin-top:2px}
.nav{display:grid;gap:4px}
.nav-link{display:flex;align-items:center;padding:10px 12px;border-radius:var(--radius-control);text-decoration:none;color:var(--color-text);font-weight:var(--weight-medium);min-height:44px}
.nav-link[aria-current="page"]{background:var(--color-surface-selected);color:var(--color-action)}
.network-note{position:absolute;bottom:24px;left:28px;color:var(--color-text-muted);font-size:var(--font-caption)}
main{min-width:0;padding:24px var(--space-page-gutter) 72px;max-width:1440px;width:100%;margin:0 auto}
.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-section-gap);margin-bottom:24px}
.page-head p{color:var(--color-text-muted)}
.refresh{font-size:var(--font-caption);color:var(--color-text-muted);white-space:nowrap;padding-top:7px}
.toolbar{display:grid;grid-template-columns:minmax(150px,.6fr) minmax(150px,.6fr) auto;gap:var(--space-content-gap);align-items:end;margin-bottom:var(--space-section-gap)}
.section{margin-top:var(--space-section-gap)}
.panel{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:18px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-content-gap);margin-bottom:10px}
.split{display:grid;grid-template-columns:minmax(0,2fr) minmax(270px,1fr);gap:var(--space-section-gap);align-items:stretch}
.split>.panel{height:100%}
.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-content-gap)}
.metric{padding:16px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}
.metric-name{color:var(--color-text-muted);font-size:var(--font-caption)}
.metric-value{font-family:var(--font-numeric);font-size:var(--font-metric);font-weight:var(--weight-strong);line-height:1.2;margin-top:4px}
.metric-detail{font-size:var(--font-caption);margin-top:5px}
.money,.number{font-family:var(--font-numeric);font-variant-numeric:tabular-nums;text-align:right}
.bar-list{display:grid;gap:12px}
.bar-row{display:grid;grid-template-columns:92px 1fr 90px;gap:12px;align-items:center}
.bar-track{height:12px;background:var(--color-page);border:1px solid var(--color-border);border-radius:var(--radius-pill);overflow:hidden}
.bar-fill{height:100%;background:var(--color-action);width:var(--bar-size)}
.state-page{min-height:58vh;display:flex;align-items:center;justify-content:center}
.state-card{width:min(560px,100%);padding:30px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);text-align:left}
.state-card h2{font-size:var(--font-heading-page)}
.state-card p{color:var(--color-text-muted);font-size:var(--font-body-large)}
.state-card .actions{margin-top:var(--space-section-gap)}
.spinner{width:30px;height:30px;border:3px solid var(--color-border);border-top-color:var(--color-action);border-radius:var(--radius-pill);animation:spin .9s linear infinite;margin-bottom:16px}
@keyframes spin{to{transform:rotate(360deg)}}
.mobile-nav{display:none}
@media (max-width:760px){
  .shell{display:block}
  .sidebar{display:none}
  main{padding:18px var(--space-page-gutter-mobile) 104px}
  .page-head{display:block;margin-bottom:18px}
  .toolbar{grid-template-columns:1fr}
  .split{grid-template-columns:1fr;align-items:start}
  .split>.panel{height:auto}
  .metric-grid{grid-template-columns:1fr 1fr}
  .bar-row{grid-template-columns:72px 1fr 76px}
  .mobile-nav{position:fixed;display:grid;grid-template-columns:repeat(4,1fr);bottom:0;left:0;right:0;background:var(--color-surface);border-top:1px solid var(--color-border);box-shadow:var(--shadow-raised);z-index:var(--layer-navigation);padding-bottom:max(4px,env(safe-area-inset-bottom))}
  .mobile-link{display:flex;align-items:center;justify-content:center;text-align:center;padding:8px 3px;color:var(--color-text);font-size:var(--font-caption);text-decoration:none;min-height:44px}
  .mobile-link[aria-current="page"]{color:var(--color-action);font-weight:var(--weight-strong);background:var(--color-surface-selected)}
}
@media (max-width:420px){.metric-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
`;
