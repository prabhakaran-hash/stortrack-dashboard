/**
 * StorTrack Regional Dashboard — access-controlled Apps Script web app.
 *
 * WHAT CHANGED FROM THE OLD VERSION
 * This used to be a pure JSON data feed that a public GitHub Pages site called
 * over an anonymous cross-origin fetch. It now ALSO serves the dashboard and
 * store-list pages itself (via HtmlService), because true per-person access
 * control needs the page load itself to go through Google's login — an
 * anonymous fetch() from another domain has no way to do that.
 *
 * DEPLOYMENT SETTINGS (Deploy > Manage deployments > pencil icon)
 *   Execute as: Me
 *   Who has access: Anyone within stortrack.com
 * That "within stortrack.com" is what makes Session.getActiveUser() reliably
 * return the visitor's real email — and what makes this a real access gate
 * instead of a name-based honor system.
 *
 * ACCESS CONTROL / LOGGING SPREADSHEET
 *   https://docs.google.com/spreadsheets/d/1qMr6iw1RFf0j9MFmeg4EDZomN5XmpGkO49aXzIh-4tU
 *   Tabs: AccessList (Email, Name, Role, Active), ViewLog, DownloadLog.
 *   To add/remove someone: just add/remove a row in AccessList — exactly like
 *   managing a Google Sheet's Share list. Set Active to NO to temporarily
 *   revoke someone without deleting their row.
 */

const SHEET_MAP = {
  canada:      { id: '1wepd7BQDsAXTB_v8HvCEn5MHyL7N9fvrEZIegteWb3I', gid: 1316439995 },
  uk:          { id: '1MB7K63fS9GVds1qa4sZMU9vSvEsyke7bmL9-IZqkM9w', gid: 1158791534 },
  australia:   { id: '1vnRv51HsAZob78xNLR6stQFL_AeDYLtxFrB2YuLlMP4', gid: 0 },
  newzealand:  { id: '16mg64rbztm5I3cbqd2WSZoxjkxLp0Glk-H6c38Zl6FM', gid: 0 }
};

const ACCESS_SHEET_ID = '1qMr6iw1RFf0j9MFmeg4EDZomN5XmpGkO49aXzIh-4tU';
const ACCESS_CACHE_SECONDS = 300;

function doGet(e) {
  const email = getUserEmail();
  const params = (e && e.parameter) || {};

  if (params.api === 'data') {
    if (!isAllowed(email)) return jsonOut({ error: 'ACCESS_DENIED' });
    return getRegionData(params.region);
  }

  if (params.api === 'logdownload') {
    if (isAllowed(email)) {
      logEvent('DownloadLog', [new Date(), email, params.region || '', params.format || '']);
    }
    return jsonOut({ ok: true });
  }

  if (!isAllowed(email)) {
    return accessDeniedPage(email);
  }

  if (params.page === 'list') {
    logEvent('ViewLog', [new Date(), email, 'store-list', params.region || '']);
    return HtmlService.createHtmlOutputFromFile('StoreList')
      .setTitle('Stortrack — Store List')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  logEvent('ViewLog', [new Date(), email, 'dashboard', '']);
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Stortrack — Self-Storage Regional Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getUserEmail() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim();
  } catch (err) {
    return '';
  }
}

function isAllowed(email) {
  if (!email) return false;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'access_' + email.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached != null) return cached === '1';

  let allowed = false;
  try {
    const sheet = SpreadsheetApp.openById(ACCESS_SHEET_ID).getSheetByName('AccessList');
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const rowEmail = String(rows[i][0] || '').trim().toLowerCase();
      const active = String(rows[i][3] || '').trim().toUpperCase();
      if (rowEmail === email.toLowerCase() && active !== 'NO') { allowed = true; break; }
    }
  } catch (err) {
    allowed = false;
  }
  cache.put(cacheKey, allowed ? '1' : '0', ACCESS_CACHE_SECONDS);
  return allowed;
}

function logEvent(sheetName, row) {
  try {
    const sheet = SpreadsheetApp.openById(ACCESS_SHEET_ID).getSheetByName(sheetName);
    sheet.appendRow(row);
  } catch (err) {
    // Logging must never break the dashboard itself.
  }
}

function getRegionData(region) {
  region = String(region || '').toLowerCase().trim();
  const cfg = SHEET_MAP[region];
  if (!cfg) {
    return jsonOut({ error: 'Unknown region "' + region + '". Valid values: ' + Object.keys(SHEET_MAP).join(', ') });
  }
  try {
    const ss = SpreadsheetApp.openById(cfg.id);
    const sheet = ss.getSheets().filter(function (s) { return s.getSheetId() === Number(cfg.gid); })[0];
    if (!sheet) throw new Error('No tab with gid ' + cfg.gid + ' found in that spreadsheet.');
    const grid = sheet.getDataRange().getValues();
    return jsonOut({ region: region, updatedAt: new Date().toISOString(), grid: grid });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function accessDeniedPage(email) {
  const who = email
    ? 'The account <strong>' + email + '</strong> is not on the approved access list for this dashboard.'
    : 'You need to be signed in with your Stortrack Google account to view this dashboard.';
  return HtmlService.createHtmlOutput(
    '<html><body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0a1120;color:#f2f5fb;display:flex;align-items:center;justify-content:center;height:100vh;">' +
    '<div style="max-width:440px;text-align:center;padding:32px;">' +
    '<h2 style="color:#ff6a6a;margin:0 0 12px;">Access restricted</h2>' +
    '<p style="line-height:1.6;">' + who + '</p>' +
    '<p style="color:#7c869c;font-size:13px;">Contact your team lead if you believe this is a mistake.</p>' +
    '</div></body></html>'
  );
}
