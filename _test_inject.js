
/* =====================================================================================
   PARSERS — label-anchored, not fixed-column. Verified against real exports of the
   Canada / UK / Australia / New Zealand "Regional Summary" tabs before shipping.
   ===================================================================================== */
function numOf(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (s === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}
function cell(grid, r, c) {
  if (r == null || r < 0 || !grid[r]) return "";
  const v = grid[r][c];
  return v == null ? "" : String(v).trim().replace(/\s+/g, " ");
}
function findCells(grid, matchFn) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = cell(grid, r, c);
      if (v && matchFn(v)) out.push({ r, c, v });
    }
  }
  return out;
}
function exact(label) { return (v) => v === label; }
// Same rationale as colOccurrences below: pick the first occurrence of `label`
// whose neighboring cell (at c+offset) is actually a number, so a header cell
// that happens to reuse the same label text elsewhere doesn't get matched instead.
function firstDataRow(grid, label, offset) {
  offset = offset == null ? 1 : offset;
  return findCells(grid, exact(label)).find((m) => numOf(cell(grid, m.r, m.c + offset)) != null) || null;
}
function colOccurrences(grid, label) {
  // Some sheets repeat operator/region names as column headers in an unrelated
  // summary table. Every real caller of this helper expects a numeric value
  // immediately to the right (a store count or a price count), so drop any match
  // where that's not true — that's a header label, not a data row.
  return findCells(grid, exact(label)).filter((m) => numOf(cell(grid, m.r, m.c + 1)) != null).sort((a, b) => a.c - b.c);
}
function firstNumberRightOf(grid, r, c, maxSpan) {
  maxSpan = maxSpan || 6;
  for (let i = 1; i <= maxSpan; i++) { const n = numOf(cell(grid, r, c + i)); if (n != null) return n; }
  return null;
}
function startsWithMatch(grid, prefix) {
  const hits = findCells(grid, (v) => v.toLowerCase().indexOf(prefix.toLowerCase()) === 0);
  return hits[0] || null;
}

// ---------------------------------------------------------------------------------------
// ANCHOR POSITION MEMORY — every table above is located by searching for known header
// text (e.g. "Category", "Province", "Facility Type") because the sheet has no other way
// to say "the table starts here." That works great until someone clears that exact header
// cell: the text search then finds nothing and the whole table would vanish, even though
// its data is still sitting right there. To avoid that, once a header is found we remember
// its row/column in localStorage; if a later parse can't find the text anymore, we reuse
// the remembered position instead of giving up — the header text is only how we FIND a
// table the first time, not where its data lives. This only fails to help on a sheet whose
// table has NEVER been seen with its header intact (no position to remember yet).
// ---------------------------------------------------------------------------------------
function loadPosCache() {
  try { return JSON.parse(localStorage.getItem("stortrack_pos_cache_v1") || "{}"); } catch (e) { return {}; }
}
function savePosCache() {
  try { localStorage.setItem("stortrack_pos_cache_v1", JSON.stringify(POS_CACHE)); } catch (e) {}
}
let POS_CACHE = loadPosCache();
function anchorPos(key, liveHit, grid) {
  if (liveHit) { POS_CACHE[key] = { r: liveHit.r, c: liveHit.c }; savePosCache(); return liveHit; }
  const cached = POS_CACHE[key];
  if (cached && grid[cached.r] !== undefined) return { r: cached.r, c: cached.c, v: cell(grid, cached.r, cached.c) };
  return null;
}
function anchorPosMulti(key, liveHits, grid) {
  if (liveHits && liveHits.length) { POS_CACHE[key] = liveHits.map((h) => ({ r: h.r, c: h.c })); savePosCache(); return liveHits; }
  const cached = POS_CACHE[key];
  if (cached && cached.length) return cached.filter((c) => grid[c.r] !== undefined).map((c) => ({ r: c.r, c: c.c, v: cell(grid, c.r, c.c) }));
  return [];
}
function anchorPosPair(key, liveHits, grid) {
  if (liveHits && liveHits.length === 2) { POS_CACHE[key] = { hits: liveHits.map((h) => ({ r: h.r, c: h.c })) }; savePosCache(); return liveHits; }
  const cached = POS_CACHE[key];
  if (cached && cached.hits && cached.hits.length === 2) return cached.hits.map((h) => ({ r: h.r, c: h.c, v: cell(grid, h.r, h.c) }));
  return null;
}

function parseUnitsSummary(grid, regionKey) {
  const rk = (regionKey || "default") + ":units";
  const actualHit = anchorPos(rk + ":actual", startsWithMatch(grid, "1. Actual"), grid);
  const estHit = anchorPos(rk + ":est", startsWithMatch(grid, "2. Estimated"), grid);
  const naHit = anchorPos(rk + ":na", startsWithMatch(grid, "No. of Units not available"), grid);
  const totalHit = anchorPos(rk + ":total", startsWithMatch(grid, "Total Stores"), grid);
  return {
    actual: actualHit ? firstNumberRightOf(grid, actualHit.r, actualHit.c) : null,
    estimated: estHit ? firstNumberRightOf(grid, estHit.r, estHit.c) : null,
    notAvailable: naHit ? firstNumberRightOf(grid, naHit.r, naHit.c) : null,
    totalStoresInUnitsTab: totalHit ? firstNumberRightOf(grid, totalHit.r, totalHit.c) : null
  };
}

// ---------------------------------------------------------------------------------------
// DYNAMIC COLUMN/ROW SCANNING — the sheet is the source of truth. A column stays part of
// a table as long as it has a header OR any data beneath it in that table's row range, so
// removing a header text (but leaving the data) still surfaces the data instead of being
// silently truncated. Scanning only stops once it hits a genuinely empty column (no header
// AND no data) — a single blank column ends a table, matching how these sheets lay tables
// out side-by-side with one blank spacer column between them.
// ---------------------------------------------------------------------------------------
function readLabelRows(grid, startRow, labelCol, stopAtTotal) {
  const rows = [];
  for (let r = startRow; r < grid.length; r++) {
    const label = cell(grid, r, labelCol);
    if (!label) break;
    if (stopAtTotal !== false && /^(grand )?total$/i.test(label)) break;
    rows.push(r);
  }
  return rows;
}
function readCols(grid, headerRow, startC, rowStart, rowEnd) {
  const rs = rowStart != null ? rowStart : headerRow + 1;
  const re = rowEnd != null ? rowEnd : grid.length;
  let width = (grid[headerRow] || []).length;
  for (let r = rs; r < re; r++) width = Math.max(width, (grid[r] || []).length);
  const cols = [];
  for (let c = startC; c < width; c++) {
    const h = cell(grid, headerRow, c);
    let hasData = false;
    for (let r = rs; r < re; r++) { if (cell(grid, r, c) !== "") { hasData = true; break; } }
    if (!h && !hasData) break;
    cols.push({ col: c, name: h });
  }
  return cols;
}

function parseRegionBlocks(grid, regionKey) {
  const candidates = ["State", "Province", "Region", "Country"];
  let label = null, hits = null;
  for (const c of candidates) {
    const h = findCells(grid, exact(c));
    if (h.length >= 2) { label = c; hits = h.slice(0, 2); break; }
  }
  hits = anchorPosPair((regionKey || "default") + ":regionBlocks", hits, grid);
  if (!hits) return null;
  function readBlock(hit) {
    const headerRow = hit.r, startC = hit.c;
    const rowIdxs = readLabelRows(grid, headerRow + 1, startC);
    const lastRow = rowIdxs.length ? rowIdxs[rowIdxs.length - 1] + 1 : headerRow + 1;
    let cols = readCols(grid, headerRow, startC + 1, headerRow + 1, lastRow);
    let totalCol = null;
    if (cols.length && /^(grand )?total$/i.test(cols[cols.length - 1].name)) {
      totalCol = cols.pop().col;
    }
    const rows = rowIdxs.map((r) => ({
      label: cell(grid, r, startC),
      values: cols.map((cc) => numOf(cell(grid, r, cc.col))),
      total: totalCol != null ? numOf(cell(grid, r, totalCol)) : null
    }));
    return { columns: cols.map((c) => c.name), rows };
  }
  return { label, blockA: readBlock(hits[0]), blockB: readBlock(hits[1]) };
}

function buildRegionSplit(rb) {
  if (!rb) return [];
  const priceByLabel = {};
  rb.blockB.rows.forEach((r) => { priceByLabel[r.label] = r; });
  const priceCols = rb.blockB.columns;
  const noIdx = priceCols.findIndex((c) => /no/i.test(c));
  const yesIdx = priceCols.findIndex((c) => /yes/i.test(c));
  return rb.blockA.rows.map((r) => {
    const p = priceByLabel[r.label];
    return {
      label: r.label,
      columns: rb.blockA.columns,
      values: r.values,
      total: r.total,
      priceNo: p && noIdx >= 0 ? p.values[noIdx] : null,
      priceYes: p && yesIdx >= 0 ? p.values[yesIdx] : null
    };
  });
}

function buildRegionPriceSplit(rb) {
  if (!rb) return [];
  return rb.blockB.rows.map((r) => ({ label: r.label, columns: rb.blockB.columns, values: r.values, total: r.total }));
}

function parseOperatorBlocks(grid, regionKey) {
  const rk = regionKey || "default";
  const catHits = findCells(grid, exact("Category"));
  function headerNamesOf(h) {
    const rowIdxs = readLabelRows(grid, h.r + 1, h.c);
    const lastRow = rowIdxs.length ? rowIdxs[rowIdxs.length - 1] + 1 : h.r + 1;
    return readCols(grid, h.r, h.c + 1, h.r + 1, lastRow).map((c) => c.name);
  }
  const blockAHit = anchorPos(rk + ":operatorBlocksA", catHits.find((h) => cell(grid, h.r, h.c + 1) === "Store Count"), grid);
  const blockBHit = anchorPos(rk + ":operatorBlocksB", catHits.find((h) => { const hdrs = headerNamesOf(h); return hdrs.includes("Available") && hdrs.includes("Not Available"); }), grid);
  if (!blockAHit) return null;
  const rowIdxsA = readLabelRows(grid, blockAHit.r + 1, blockAHit.c);
  const rows = rowIdxsA.map((r) => ({ label: cell(grid, r, blockAHit.c), stores: numOf(cell(grid, r, blockAHit.c + 1)) }));
  const priceByLabel = {};
  if (blockBHit) {
    const rowIdxsB = readLabelRows(grid, blockBHit.r + 1, blockBHit.c);
    const lastRowB = rowIdxsB.length ? rowIdxsB[rowIdxsB.length - 1] + 1 : blockBHit.r + 1;
    const cols = readCols(grid, blockBHit.r, blockBHit.c + 1, blockBHit.r + 1, lastRowB);
    const availCol = cols.find((c) => c.name === "Available");
    const naCol = cols.find((c) => c.name === "Not Available");
    rowIdxsB.forEach((r) => {
      const label = cell(grid, r, blockBHit.c);
      priceByLabel[label] = { yes: availCol ? numOf(cell(grid, r, availCol.col)) : null, no: naCol ? numOf(cell(grid, r, naCol.col)) : null };
    });
  }
  return rows.map((r) => ({ label: r.label, stores: r.stores, yes: priceByLabel[r.label] ? priceByLabel[r.label].yes : null, no: priceByLabel[r.label] ? priceByLabel[r.label].no : null }));
}

function parseFacilityDetail(grid, regionKey) {
  const hit = anchorPos((regionKey || "default") + ":facilityDetail", findCells(grid, exact("Category")).find((m) => cell(grid, m.r, m.c + 1) === "Facility Type"), grid);
  if (!hit) return null;
  const rowIdxs = readLabelRows(grid, hit.r + 1, hit.c + 1);
  const lastRow = rowIdxs.length ? rowIdxs[rowIdxs.length - 1] + 1 : hit.r + 1;
  const cols = readCols(grid, hit.r, hit.c + 2, hit.r + 1, lastRow);
  const yesCol = cols.find((c) => /yes/i.test(c.name));
  const noCol = cols.find((c) => /\bno\b/i.test(c.name));
  const totalCol = cols.find((c) => /^total$/i.test(c.name)) || cols[cols.length - 1];
  const rows = [];
  let lastCategory = "";
  rowIdxs.forEach((r) => {
    const rawCat = cell(grid, r, hit.c);
    const facType = cell(grid, r, hit.c + 1);
    const category = rawCat || lastCategory;
    lastCategory = category;
    rows.push({
      category, type: facType,
      yes: yesCol ? numOf(cell(grid, r, yesCol.col)) : null,
      no: noCol ? numOf(cell(grid, r, noCol.col)) : null,
      total: totalCol ? numOf(cell(grid, r, totalCol.col)) : null
    });
  });
  return rows.length ? rows : null;
}

function parseFacilityOperatorNrsf(grid, regionKey) {
  const hit = anchorPos((regionKey || "default") + ":facilityOperatorNrsf", findCells(grid, exact("Facility Type")).find((m) => cell(grid, m.r, m.c + 1) === "Category" && cell(grid, m.r, m.c + 2) === "Store Count"), grid);
  if (!hit) return null;
  const rowIdxs = readLabelRows(grid, hit.r + 1, hit.c + 1);
  const lastRow = rowIdxs.length ? rowIdxs[rowIdxs.length - 1] + 1 : hit.r + 1;
  const cols = readCols(grid, hit.r, hit.c + 2, hit.r + 1, lastRow);
  const storesCol = cols.find((c) => /store count/i.test(c.name)) || cols[0];
  const nrsfCol = cols.find((c) => /^nrsf$/i.test(c.name) || (/nrsf/i.test(c.name) && !/total/i.test(c.name)));
  const totalStoresCol = cols.find((c) => /total stores/i.test(c.name));
  const totalNrsfCol = cols.find((c) => /total nrsf/i.test(c.name));
  const rows = [];
  let lastFacility = "";
  rowIdxs.forEach((r) => {
    const rawFac = cell(grid, r, hit.c);
    const opLabel = cell(grid, r, hit.c + 1);
    const facility = rawFac || lastFacility;
    lastFacility = facility;
    rows.push({
      facility, operator: opLabel,
      stores: storesCol ? (numOf(cell(grid, r, storesCol.col)) || 0) : 0,
      nrsf: nrsfCol ? numOf(cell(grid, r, nrsfCol.col)) : null,
      totalStores: totalStoresCol ? numOf(cell(grid, r, totalStoresCol.col)) : null,
      totalNrsf: totalNrsfCol ? numOf(cell(grid, r, totalNrsfCol.col)) : null
    });
  });
  return rows.length ? rows : null;
}

function parseCanadaT(grid, regionKey) {
  const operatorType = parseOperatorBlocks(grid, regionKey) || [];
  const totalStores = operatorType.reduce((s, o) => s + (o.stores || 0), 0);
  const pricing = { yes: operatorType.reduce((s, o) => s + (o.yes || 0), 0), no: operatorType.reduce((s, o) => s + (o.no || 0), 0) };
  const rb = parseRegionBlocks(grid, regionKey);
  const regionSplit = buildRegionSplit(rb);
  const regionPriceSplit = buildRegionPriceSplit(rb);
  const facilityDetail = parseFacilityDetail(grid, regionKey);
  const facilityType = {};
  (facilityDetail || []).forEach((d) => { facilityType[d.category] = (facilityType[d.category] || 0) + (d.total || 0); });
  return { totalStores, pricing, operatorType,
    regionSplit, regionPriceSplit, facilityType, pricingHistory: parsePricingHistory(grid, regionKey), facilityDetail, facilityOperatorNrsf: null, units: parseUnitsSummary(grid, regionKey), sqftTotal: null, regionLabel: "Province" };
}

function parseUKT(grid, regionKey) {
  const operatorType = parseOperatorBlocks(grid, regionKey) || [];
  const totalStores = operatorType.reduce((s, o) => s + (o.stores || 0), 0);
  const pricing = { yes: operatorType.reduce((s, o) => s + (o.yes || 0), 0), no: operatorType.reduce((s, o) => s + (o.no || 0), 0) };
  const rb = parseRegionBlocks(grid, regionKey);
  const regionSplit = buildRegionSplit(rb);
  const regionPriceSplit = buildRegionPriceSplit(rb);
  const nrsfRows = parseFacilityOperatorNrsf(grid, regionKey);
  const facilityOperatorNrsf = (nrsfRows || []).map((r) => ({ facility: r.facility.startsWith("Hybrid") ? "Hybrid" : r.facility, operator: r.operator, stores: r.stores, nrsf: r.nrsf, totalStores: r.totalStores, totalNrsf: r.totalNrsf }));
  const facilityType = {};
  facilityOperatorNrsf.forEach((d) => { facilityType[d.facility] = (facilityType[d.facility] || 0) + (d.stores || 0); });
  const sqftTotal = facilityOperatorNrsf.reduce((s, d) => s + (d.nrsf || 0), 0);
  return { totalStores, pricing, operatorType, regionSplit, regionPriceSplit, facilityType, facilityOperatorNrsf, pricingHistory: parsePricingHistory(grid, regionKey), facilityDetail: null, units: parseUnitsSummary(grid, regionKey), sqftTotal, regionLabel: "Region" };
}

function parseAustraliaT(grid, regionKey) {
  const operatorType = parseOperatorBlocks(grid, regionKey) || [];
  const totalStores = operatorType.reduce((s, o) => s + (o.stores || 0), 0);
  const pricing = { yes: operatorType.reduce((s, o) => s + (o.yes || 0), 0), no: operatorType.reduce((s, o) => s + (o.no || 0), 0) };
  const rb = parseRegionBlocks(grid, regionKey);
  const regionSplit = buildRegionSplit(rb);
  const regionPriceSplit = buildRegionPriceSplit(rb);
  return { totalStores, pricing, operatorType, regionSplit, regionPriceSplit, facilityType: null, pricingHistory: parsePricingHistory(grid, regionKey), facilityDetail: null, facilityOperatorNrsf: null, units: parseUnitsSummary(grid, regionKey), sqftTotal: null, regionLabel: "State" };
}

function parseNewZealandT(grid, regionKey) {
  const operatorType = parseOperatorBlocks(grid, regionKey) || [];
  const totalStores = operatorType.reduce((s, o) => s + (o.stores || 0), 0);
  const pricing = { yes: operatorType.reduce((s, o) => s + (o.yes || 0), 0), no: operatorType.reduce((s, o) => s + (o.no || 0), 0) };
  return { totalStores, pricing, operatorType, regionSplit: null, facilityType: null, pricingHistory: parsePricingHistory(grid, regionKey), facilityDetail: null, facilityOperatorNrsf: null, units: parseUnitsSummary(grid, regionKey), sqftTotal: null, regionLabel: null };
}

function parseSourceCoverage(grid, unitLabel, regionKey) {
  const hit = anchorPos((regionKey || "default") + ":sourceCoverage", findCells(grid, exact("Source")).find((m) => cell(grid, m.r, m.c + 1) !== ""), grid);
  if (!hit) return null;
  const rowIdxsAll = readLabelRows(grid, hit.r + 1, hit.c, false);
  let totalRowIdx = null;
  const dataRowIdxs = [];
  for (const r of rowIdxsAll) {
    const label = cell(grid, r, hit.c);
    if (label.toLowerCase() === "total") { totalRowIdx = r; break; }
    dataRowIdxs.push(r);
  }
  const lastRow = (totalRowIdx != null ? totalRowIdx : (dataRowIdxs.length ? dataRowIdxs[dataRowIdxs.length - 1] : hit.r)) + 1;
  const cols = readCols(grid, hit.r, hit.c + 1, hit.r + 1, lastRow);
  if (!cols.length) return null;
  const labelHeader = cell(grid, hit.r, hit.c) || "Source";
  const rows = dataRowIdxs.map((r) => ({ label: cell(grid, r, hit.c), values: cols.map((cc) => numOf(cell(grid, r, cc.col))) }));
  const total = totalRowIdx != null ? { label: cell(grid, totalRowIdx, hit.c), values: cols.map((cc) => numOf(cell(grid, totalRowIdx, cc.col))) } : null;
  return { unitLabel: unitLabel || "Size", labelHeader, columns: cols.map((c) => c.name), rows, total };
}
function parseStoreProfile(grid, regionKey) {
  const rk = regionKey || "default";
  const statusHit = anchorPos(rk + ":storeProfileStatus", findCells(grid, exact("Region")).find((m) => cell(grid, m.r, m.c + 1) === "Total Stores"), grid);
  let status = null;
  if (statusHit) {
    const r = statusHit.r + 1;
    const cols = readCols(grid, statusHit.r, statusHit.c + 1, r, r + 1);
    status = {
      region: cell(grid, r, statusHit.c),
      columns: cols.map((c) => c.name),
      values: cols.map((cc) => numOf(cell(grid, r, cc.col)))
    };
  }
  const attrHit = anchorPos(rk + ":storeProfileAttr", findCells(grid, exact("Attribute Group")).find((m) => cell(grid, m.r, m.c + 1) === "Attribute Name"), grid);
  let attrCols = [];
  let groupHeader = "Group", nameHeader = "Attribute";
  const attributes = [];
  if (attrHit) {
    groupHeader = cell(grid, attrHit.r, attrHit.c) || groupHeader;
    nameHeader = cell(grid, attrHit.r, attrHit.c + 1) || nameHeader;
    const rowIdxs = readLabelRows(grid, attrHit.r + 1, attrHit.c + 1);
    const lastRow = rowIdxs.length ? rowIdxs[rowIdxs.length - 1] + 1 : attrHit.r + 1;
    attrCols = readCols(grid, attrHit.r, attrHit.c + 2, attrHit.r + 1, lastRow);
    let lastGroup = "";
    rowIdxs.forEach((r) => {
      const name = cell(grid, r, attrHit.c + 1);
      const group = cell(grid, r, attrHit.c) || lastGroup;
      lastGroup = group;
      attributes.push({ group, name, values: attrCols.map((cc) => numOf(cell(grid, r, cc.col))) });
    });
  }
  return { status, groupHeader, nameHeader, attrColumns: attrCols.map((c) => c.name), attributes };
}
function parseOwnersSection(grid, sectionLabel, cacheKey) {
  const hit = anchorPos(cacheKey, findCells(grid, exact(sectionLabel))[0], grid);
  if (!hit) return null;
  const headerRow = hit.r + 1;
  const startC = hit.c;
  const rowIdxs = readLabelRows(grid, headerRow + 1, startC);
  const lastRow = rowIdxs.length ? rowIdxs[rowIdxs.length - 1] + 1 : headerRow + 1;
  const cols = readCols(grid, headerRow, startC + 1, headerRow + 1, lastRow);
  if (!cols.length) return null;
  const labelHeader = cell(grid, headerRow, startC) || "Category";
  const rows = rowIdxs.map((r) => ({ label: cell(grid, r, startC), values: cols.map((cc) => numOf(cell(grid, r, cc.col))) }));
  return rows.length ? { labelHeader, columns: cols.map((c) => c.name), rows } : null;
}
function parseOwnersContacts(grid, regionKey) {
  const rk = regionKey || "default";
  const ownerCompany = parseOwnersSection(grid, "Owner Company Summary*", rk + ":ownersCompanyStar") || parseOwnersSection(grid, "Owner Company Summary", rk + ":ownersCompany");
  const contacts = parseOwnersSection(grid, "Contacts Summary", rk + ":ownersContacts");
  return (ownerCompany || contacts) ? { ownerCompany, contacts } : null;
}
function parseDevelopments(grid, regionKey) {
  const hits = anchorPosMulti((regionKey || "default") + ":developments", findCells(grid, exact("Region / Stage")), grid);
  if (!hits.length) return null;
  const sections = hits.map((hit) => {
    const titleRaw = hit.r > 0 ? cell(grid, hit.r - 1, hit.c) : "";
    const title = titleRaw && titleRaw.trim() ? titleRaw.trim() : null;
    const headerRow = grid[hit.r] || [];
    let totalIdx = -1;
    for (let i = hit.c + 1; i < headerRow.length; i++) { if (cell(grid, hit.r, i).toLowerCase() === "total") { totalIdx = i; break; } }
    const stageCols = [];
    for (let cc = hit.c + 1; cc < (totalIdx > -1 ? totalIdx : headerRow.length); cc++) {
      stageCols.push({ col: cc, label: cell(grid, hit.r, cc) });
    }
    const rows = [];
    for (let r = hit.r + 1; r < grid.length; r++) {
      const region = cell(grid, r, hit.c);
      if (!region) break;
      const stages = stageCols.map((s) => ({ label: s.label, value: numOf(cell(grid, r, s.col)) }));
      const total = totalIdx > -1 ? numOf(cell(grid, r, totalIdx)) : null;
      rows.push({ region, stages, total });
    }
    return { title, rows };
  }).filter((s) => s.rows.length);
  return sections.length ? sections : null;
}

function parsePricingHistory(grid, regionKey) {
  const catHits = findCells(grid, exact("Category"));
  function colsOf(h) {
    const rowIdxs = readLabelRows(grid, h.r + 1, h.c, false);
    const lastRow = rowIdxs.length ? rowIdxs[rowIdxs.length - 1] + 1 : h.r + 1;
    return readCols(grid, h.r, h.c + 1, h.r + 1, lastRow);
  }
  const liveHit = catHits.find((h) => {
    const cols = colsOf(h);
    const names = cols.map((c) => c.name);
    return names.includes("Available") && names.includes("Not Available") && cols.some((c) => /history/i.test(c.name));
  });
  const hit = anchorPos((regionKey || "default") + ":pricingHistory", liveHit, grid);
  if (!hit) return null;
  const rowIdxsAll = readLabelRows(grid, hit.r + 1, hit.c, false);
  const dataRowIdxs = [];
  for (const r of rowIdxsAll) {
    const label = cell(grid, r, hit.c);
    dataRowIdxs.push(r);
    if (label.toLowerCase() === "grand total") break;
  }
  const lastRow = (dataRowIdxs.length ? dataRowIdxs[dataRowIdxs.length - 1] : hit.r) + 1;
  const cols = readCols(grid, hit.r, hit.c + 1, hit.r + 1, lastRow);
  const colByName = (name) => { const f = cols.find((c) => c.name === name); return f ? f.col : null; };
  const availCol = colByName("Available");
  const naCol = colByName("Not Available");
  const totalCol = cols.find((c) => /^(grand )?total$/i.test(c.name));
  const historyCol = cols.find((c) => /history/i.test(c.name));
  const rows = dataRowIdxs.map((r) => ({
    label: cell(grid, r, hit.c),
    available: availCol != null ? numOf(cell(grid, r, availCol)) : null,
    notAvailable: naCol != null ? numOf(cell(grid, r, naCol)) : null,
    total: totalCol ? numOf(cell(grid, r, totalCol.col)) : null,
    withHistory: historyCol ? numOf(cell(grid, r, historyCol.col)) : null
  }));
  return rows.length ? rows : null;
}

/* =====================================================================================
   CONFIG — one entry per region. sheetId/gid come straight from the "Regional Summary"
   (or "Summary") tab of each Google Sheet. All four sheets must stay shared as at least
   "Anyone with the link can view" for the browser fetch below to succeed without login.
   ===================================================================================== */
// Paste the /exec URL from your Apps Script deployment here once you have it
// (see AppsScript_Code.gs). Until it's set, the dashboard falls back to
// Google's public CSV export, which requires the sheet to stay link-shared.
