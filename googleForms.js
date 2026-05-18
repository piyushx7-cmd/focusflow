/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FocusFlow × Google Forms Integration
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight, frontend-only session storage using Google Forms + Google Sheets.
 * No backend server, no API keys, no cost.
 *
 * How it works:
 *  1. When a Pomodoro session ends, buildSessionData() assembles a payload.
 *  2. saveSessionLocally() persists it to localStorage for instant access.
 *  3. submitSessionToGoogleForms() POSTs it to the Google Form via fetch()
 *     with mode:"no-cors" — responses land directly in the linked Google Sheet.
 *
 * Duplicate Prevention:
 *  Each submission is fingerprinted by taskName + ISO timestamp.
 *  The fingerprint is stored in localStorage; duplicate calls are silently skipped.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ─── Google Form Configuration ─────────────────────────────────────────── */
const GOOGLE_FORM_CONFIG = {
  // POST target — /formResponse (not /viewform)
  formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSdACgmanYMQjgrx3znMmVM9YOoSi0KZ0jbmNene14LoyhKs7A/formResponse',

  // Map each data field → its Google Form entry ID
  fields: {
    taskName:          'entry.821344130',
    focusDuration:     'entry.2097327325',
    breakDuration:     'entry.2002011705',
    sessionsCompleted: 'entry.87048419',
    dateTime:          'entry.1002729884',
    status:            'entry.588503810',
  },
};

/* ─── localStorage Keys ──────────────────────────────────────────────────── */
const LS_SESSIONS_KEY   = 'focusflow_sessions';      // Array of all session objects
const LS_SUBMITTED_KEY  = 'focusflow_submitted_ids'; // Set of already-submitted fingerprints

/* ─── Helpers ────────────────────────────────────────────────────────────── */

/**
 * Generate a unique fingerprint for a session to detect duplicates.
 * Uses taskName + dateTime so two sessions at the same second with the same
 * task name (extremely unlikely in practice) share a fingerprint.
 */
function _sessionFingerprint(data) {
  return `${data.taskName}__${data.dateTime}`;
}

/**
 * Load the set of already-submitted fingerprints from localStorage.
 * @returns {Set<string>}
 */
function _loadSubmittedIds() {
  try {
    const raw = localStorage.getItem(LS_SUBMITTED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

/**
 * Persist the set of submitted fingerprints back to localStorage.
 * Caps the set at 500 entries to avoid unbounded growth.
 * @param {Set<string>} ids
 */
function _saveSubmittedIds(ids) {
  try {
    let arr = Array.from(ids);
    if (arr.length > 500) arr = arr.slice(arr.length - 500); // keep newest 500
    localStorage.setItem(LS_SUBMITTED_KEY, JSON.stringify(arr));
  } catch (e) {
    console.warn('[FocusFlow] Could not persist submitted IDs:', e);
  }
}

/* ─── Public API ─────────────────────────────────────────────────────────── */

/**
 * Save a session object to localStorage history.
 * @param {Object} data - Session data built by buildSessionData()
 */
function saveSessionLocally(data) {
  try {
    const existing = JSON.parse(localStorage.getItem(LS_SESSIONS_KEY) || '[]');
    existing.push({ ...data, savedAt: new Date().toISOString() });
    // Cap history at 1000 sessions
    if (existing.length > 1000) existing.splice(0, existing.length - 1000);
    localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(existing));
    console.log('[FocusFlow] Session saved locally ✓', data);
  } catch (e) {
    console.warn('[FocusFlow] localStorage save failed:', e);
  }
}

/**
 * Retrieve all locally stored sessions.
 * @returns {Array<Object>}
 */
function getSessionHistory() {
  try {
    return JSON.parse(localStorage.getItem(LS_SESSIONS_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Submit session data to Google Forms via fetch (no-cors, fire-and-forget).
 * Silently skips duplicate submissions (same task + timestamp fingerprint).
 *
 * @param {Object} data
 * @param {string} data.taskName          - Task the user worked on
 * @param {number} data.focusDuration     - Focus block length in minutes
 * @param {number} data.breakDuration     - Break length in minutes
 * @param {number} data.sessionsCompleted - Total sessions done in this sitting
 * @param {string} data.dateTime          - Human-readable timestamp
 * @param {string} data.status            - "completed" | "skipped"
 */
async function submitSessionToGoogleForms(data) {
  const fingerprint = _sessionFingerprint(data);
  const submittedIds = _loadSubmittedIds();

  // ── Duplicate guard ──────────────────────────────────────────────────────
  if (submittedIds.has(fingerprint)) {
    console.log('[FocusFlow] Duplicate submission skipped:', fingerprint);
    return;
  }

  // ── Build URL-encoded payload ────────────────────────────────────────────
  const { fields, formUrl } = GOOGLE_FORM_CONFIG;

  // Parse the datetime into components Google Forms date-time field expects
  const now = new Date();
  const params = new URLSearchParams({
    [fields.taskName]:          String(data.taskName),
    [fields.focusDuration]:     String(data.focusDuration),
    [fields.breakDuration]:     String(data.breakDuration),
    [fields.sessionsCompleted]: String(data.sessionsCompleted),
    // Date-time field (type 9) requires year/month/day/hour/minute sub-keys
    [fields.dateTime + '_year']:   String(now.getFullYear()),
    [fields.dateTime + '_month']:  String(now.getMonth() + 1),
    [fields.dateTime + '_day']:    String(now.getDate()),
    [fields.dateTime + '_hour']:   String(now.getHours()),
    [fields.dateTime + '_minute']: String(now.getMinutes()),
    [fields.status]:            String(data.status),
  });

  // ── Submit ───────────────────────────────────────────────────────────────
  try {
    await fetch(formUrl, {
      method: 'POST',
      mode:   'no-cors', // required — Google Forms doesn't send CORS headers
      // NOTE: do NOT set Content-Type manually — browsers block custom headers
      // in no-cors mode and the request is silently dropped. Let the browser
      // auto-set it from the URLSearchParams body.
      body:   params.toString(),
    });

    // Mark as submitted (no-cors means we can't verify response, but treat
    // a resolved promise as "sent successfully")
    submittedIds.add(fingerprint);
    _saveSubmittedIds(submittedIds);
    console.log('[FocusFlow] Submitted to Google Forms ✓', data);

  } catch (err) {
    // Network error — don't crash the timer, just log
    console.warn('[FocusFlow] Google Forms submission failed (will retry next session):', err);
  }
}
