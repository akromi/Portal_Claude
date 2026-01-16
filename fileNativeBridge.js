(function (window) {
  'use strict';

  const LOG = (...a) => console.log('[file-bridge]', ...a);
  const DBG = (...a) => console.debug('[file-bridge]', ...a);

  const DEFAULT_ALLOWED_EXTENSIONS = ["pdf", "jpg", "png", "gif"];
  const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

  // Default localized messages (double-quoted; FR uses curly apostrophe and NBSP)
  const DEFAULT_MESSAGES = {
    en: {
      required: "This file is required.",
      zeroByte: "The selected file is empty (0 bytes). Please choose a non-empty file.",
      maxSize: "The file is too large. Maximum file size is {MB} MB.",
      fileTypes: "The file type is not allowed. Allowed types: {list}."
    },
    fr: {
      required: "Ce fichier est obligatoire.",
      zeroByte: "Le fichier sélectionné est vide (0\u00A0octet). Veuillez choisir un fichier non vide.",
      maxSize: "Le fichier est trop volumineux. La taille maximale est de {MB}\u00A0Mo.",
      fileTypes: "Le type de fichier n\u2019est pas autorisé. Types permis\u00A0: {list}."
    }
  };

  // Programmatic opt-in state
  const optedInForms = new WeakSet();
  const optedInFields = new Set();
  // Track which baseIds have the bridge enabled so we can re-bind after partial postbacks.
  const enabledBaseIds = new Set();
  let prmEndRequestHooked = false;
  let deleteClickHooked = false;

  function getHiddenByIds(ids) {
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) return el;
    }
    return null;
  }

  function getHiddenValue(baseId, suffix) {
    var el = getHiddenByIds([baseId + suffix, baseId + '_' + suffix]);
    return el ? String(el.value || '').trim() : '';
  }

  // Keep UI consistent after server-side file delete where PP can leave stale filename spans/buttons.
  function syncDeleteButtonVisibility(baseId) {
    try {
      var btn = document.getElementById(baseId + '_delete_button');
      if (!btn) return;

      var change = getHiddenValue(baseId, 'hidden_file_change').toLowerCase();
      var hiddenFilename = getHiddenValue(baseId, 'hidden_filename');
      var hasServerFile = !!hiddenFilename && change !== 'delete';

      if (!hasServerFile) {
        // Hide delete button (and remove from tab order)
        btn.style.display = 'none';
        btn.setAttribute('aria-hidden', 'true');
        btn.setAttribute('tabindex', '-1');

        // Clear stale filename if present (prevents bridge falsely treating it as existing)
        var nameSpan = document.getElementById(baseId + '_file_name');
        if (nameSpan) nameSpan.textContent = '';

        DBG('syncDeleteButtonVisibility: hide delete for', baseId, { change: change, hiddenFilename: hiddenFilename });
      } else {
        // Do not force-show: PP / your relabel logic owns the "show" state.
        btn.removeAttribute('aria-hidden');
        btn.removeAttribute('tabindex');
      }
    } catch (e) {
      DBG('syncDeleteButtonVisibility: error for', baseId, e);
    }
  }

  function ensureEndRequestHook() {
    if (prmEndRequestHooked) return;
    try {
      if (window.Sys && window.Sys.WebForms && window.Sys.WebForms.PageRequestManager) {
        var prm = window.Sys.WebForms.PageRequestManager.getInstance();
        if (prm && prm.add_endRequest) {
          prm.add_endRequest(function () {
            try {
              enabledBaseIds.forEach(function (baseId) {
                // Re-bind to newly rendered inputs after partial postback
                try { register(baseId); } catch (_) {}
                try { syncDeleteButtonVisibility(baseId); } catch (_) {}
              });
            } catch (_) {}
          });
          prmEndRequestHooked = true;
          LOG('Hooked PageRequestManager.endRequest');
        }
      }
    } catch (e) {
      DBG('ensureEndRequestHook: error', e);
    }
  }

  function ensureDeleteClickHook() {
    if (deleteClickHooked) return;
    deleteClickHooked = true;
    // Capture-phase delegation so it works even when PP replaces the button DOM.
    document.addEventListener('click', function (evt) {
      try {
        var t = evt && evt.target;
        if (!t) return;
        var btn = t.closest ? t.closest('button[id$="_delete_button"]') : null;
        if (!btn || !btn.id) return;
        var baseId = btn.id.replace(/_delete_button$/, '');
        // Defer: let Power Pages set hidden_file_change before we reconcile UI.
        setTimeout(function () { syncDeleteButtonVisibility(baseId); }, 0);
      } catch (_) {}
    }, true);
  }

  function getCurrentLang() {
    const lang = (document.documentElement.getAttribute('lang') || 'en').toLowerCase();
    return lang.startsWith('fr') ? 'fr' : 'en';
  }

  // Try to re-use the platform RequiredFieldValidator message for the hidden filename field
  function getRequiredMessageFromHidden(input, lang) {
    try {
      if (!input || !input.id) return "";

      var inputId = String(input.id);
      // file inputs are usually "<baseId>_input_file"
      var baseId = inputId.replace(/_input_file$/, '');

      // Typical PP patterns:
      //   ethi_uploadshipparticulars_input_file  -> ethi_uploadshipparticularshidden_filename
      //   <baseId>_input_file                    -> <baseId>_hidden_filename (fallback)
      var hiddenIds = [
        baseId + 'hidden_filename',
        baseId + '_hidden_filename'
      ];

      if (window.Page_Validators && Array.isArray(window.Page_Validators)) {
        for (var h = 0; h < hiddenIds.length; h++) {
          var hid = hiddenIds[h];
          if (!hid) continue;

          for (var i = 0; i < window.Page_Validators.length; i++) {
            var v = window.Page_Validators[i];
            if (!v) continue;
            if (String(v.controltovalidate || '') !== hid) continue;

            // Prefer the stock RequiredFieldValidator for this hidden field
            if (typeof v.id === 'string' &&
                v.id.indexOf('RequiredFieldValidator') !== 0) {
              continue;
            }

            var raw = v.errormessage || "";
            if (!raw) continue;

            // Strip any HTML (anchors, spans) to get plain text
            var tmp = document.createElement('div');
            tmp.innerHTML = raw;
            var txt = (tmp.textContent || tmp.innerText || '').trim();
            if (txt) return txt;
          }
        }
      }
    } catch (e) {
      DBG('getRequiredMessageFromHidden: error resolving message for', input && input.id, e);
    }
    return "";
  }

  // function getMessage(input, key, lang) {
  //   // keys for data-msg-*: required, zero, max, type
  //   const dataKey = `data-msg-${key}-${lang}`;
  //   const custom = input.getAttribute(dataKey);
  //   if (custom) return custom;
  //   const map = { zero: 'zeroByte', max: 'maxSize', type: 'fileTypes' };
  //   const defaults = DEFAULT_MESSAGES[lang] || DEFAULT_MESSAGES.en;
  //   return defaults[map[key] || key] || "";
  // }

  function getMessage(input, key, lang) {
    // keys for data-msg-*: required, zero, max, type
    const dataKey = `data-msg-${key}-${lang}`;
    const custom = input.getAttribute(dataKey);
    if (custom) return custom;

    // For "required", try to re-use the PP RequiredFieldValidator message
    if (key === 'required') {
      const fromHidden = getRequiredMessageFromHidden(input, lang);
      if (fromHidden) return fromHidden;
    }

    const map = { zero: 'zeroByte', max: 'maxSize', type: 'fileTypes' };
    const defaults = DEFAULT_MESSAGES[lang] || DEFAULT_MESSAGES.en;
    return defaults[map[key] || key] || "";
  }


  function getFileInput(baseId) {
    return document.getElementById(baseId + '_input_file') || document.getElementById(baseId);
  }

    // NEW: treat existing server-side file as satisfying "required" when no local file is selected
  function hasExistingServerFile(baseId, input) {
    try {
      // 0) If Power Pages indicates the server file was deleted, treat as NO existing file.
      //    This prevents stale filename spans/links from keeping the field "valid" after delete.
      var changeIds = [
        baseId + 'hidden_file_change',
        baseId + '_hidden_file_change'
      ];
      for (var c = 0; c < changeIds.length; c++) {
        var ch = document.getElementById(changeIds[c]);
        if (ch) {
          var cv = String(ch.value || '').trim().toLowerCase();
          if (cv === 'delete') {
            DBG('hasExistingServerFile: hidden_file_change=delete on', changeIds[c], 'for', baseId);
            return false;
          }
        }
      }

      // 1) Explicit marker on the container, if present
      var container = input && input.closest ? input.closest('.file-control-container') : null;
      if (container && container.hasAttribute('data-has-server-file')) {
        var flag = container.getAttribute('data-has-server-file');
        if (flag === '' || flag === 'true' || flag === '1') {
          DBG('hasExistingServerFile: container data-has-server-file=true for', baseId);
          return true;
        }
      }

      // 2) Hidden "filename" fields rendered by Power Pages
      //    Step3 uses e.g. ethi_uploadshipparticularshidden_filename (no underscore)
      var hiddenIds = [
        baseId + 'hidden_filename',   // e.g. ethi_uploadshipparticularshidden_filename
        baseId + '_hidden_filename'   // fallback pattern if used elsewhere
      ];
      var hasHiddenFilenameField = false;
      for (var i = 0; i < hiddenIds.length; i++) {
        var h = document.getElementById(hiddenIds[i]);
        if (!h) continue;
        hasHiddenFilenameField = true;
        if (String(h.value || '').trim().length > 0) {
          DBG('hasExistingServerFile: hidden filename present on', hiddenIds[i], 'for', baseId);
          return true;
        }
      }

      // If the hidden filename field exists and is empty, treat as NO server file.
      // Do NOT fall back to the visible filename span because it can remain stale after delete.
      if (hasHiddenFilenameField) {
        DBG('hasExistingServerFile: hidden filename empty for', baseId);
        return false;
      }

      // 3) Visible filename span (only if no hidden field is present)
      var nameSpan = document.getElementById(baseId + '_file_name');
      if (nameSpan) {
        var txt = String(nameSpan.textContent || '').trim();
        // Skip typical "no file selected" text in EN/FR
        if (txt &&
            !/Aucun fichier sélectionné/i.test(txt) &&
            !/No file selected/i.test(txt)) {
          DBG('hasExistingServerFile: non-empty file name span for', baseId);
          return true;
        }
      }
    } catch (e) {
      DBG('hasExistingServerFile: error while probing for existing file on', baseId, e);
    }
    return false;
  }

  function getConfig(input) {
    const allowedExtStr = input.getAttribute('data-allowed-ext') || '';
    const allowedExt = allowedExtStr
      ? allowedExtStr.split(/[\,\s;|]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
      : DEFAULT_ALLOWED_EXTENSIONS;

    const maxBytesAttr = input.getAttribute('data-max-bytes');
    const maxBytes = (maxBytesAttr && !isNaN(maxBytesAttr))
      ? parseInt(maxBytesAttr, 10)
      : (typeof window.DEFAULT_MAX_FILE_BYTES === 'number' ? window.DEFAULT_MAX_FILE_BYTES : DEFAULT_MAX_BYTES);

    return { allowedExt, maxBytes };
  }

  function ancestorFormOf(input) {
    return input?.form || input?.closest?.('form') || null;
  }

  function formIsOptedIn(form) {
    return !!(form && optedInForms.has(form));
  }

  function isEligible(baseId, input) {
    if (!input) return false;
    // per-input opt-out still supported
    if (input.matches('[data-file-bridge="off"]')) return false;
    if (input.disabled || String(input.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
    if (optedInFields.has(baseId)) return true;
    const form = ancestorFormOf(input);
    return formIsOptedIn(form);
  }


  // Public bridge helper (idempotent)
window.triggerValidationNow = function (baseId, type) {
  try { if (typeof updatesOnChange === 'function') { updatesOnChange({ id: baseId, type: type || 'file' }, new Event('synthetic')); } } catch (e) {}
  try { if (typeof globalEvaluationFunction === 'function') { globalEvaluationFunction(); } } catch (e) {}
};


  // function validateFile(baseId, input, lang) {
  //   const config = getConfig(input);
  //   const file = input.files && input.files[0];

  //   if (!file || input.files.length === 0) {
  //     return { valid: false, errorType: 'required', errorMessage: getMessage(input, 'required', lang) };
  //   }
  //   if (file.size === 0) {
  //     return { valid: false, errorType: 'zeroByte', errorMessage: getMessage(input, 'zero', lang) };
  //   }
  //   if (file.size > config.maxBytes) {
  //     const mb = (config.maxBytes / (1024 * 1024)).toFixed(1);
  //     let msg = getMessage(input, 'max', lang).replace('{MB}', mb);
  //     return { valid: false, errorType: 'maxSize', errorMessage: msg };
  //   }
  //   const name = String(file.name || '').trim();
  //   const dot = name.lastIndexOf('.');
  //   if (dot <= 0) {
  //     let msg = getMessage(input, 'type', lang).replace('{list}', config.allowedExt.join(', '));
  //     return { valid: false, errorType: 'fileTypes', errorMessage: msg };
  //   }
  //   const ext = name.slice(dot + 1).toLowerCase();
  //   if (!config.allowedExt.includes(ext)) {
  //     let msg = getMessage(input, 'type', lang).replace('{list}', config.allowedExt.join(', '));
  //     return { valid: false, errorType: 'fileTypes', errorMessage: msg };
  //   }
  //   return { valid: true, errorType: null, errorMessage: '' };
  // }

  //   function validateFile(baseId, input, lang) {
  //   const config = getConfig(input);

  //   const files = input && input.files ? input.files : null;
  //   const file = files && files.length ? files[0] : null;

  //   // No local file selected
  //   if (!file || !files || files.length === 0) {
  //     // If the record already has a server-side file, "required" is satisfied
  //     if (hasExistingServerFile(baseId, input)) {
  //       DBG('validateFile: no local file but existing server file detected for', baseId);
  //       return { valid: true, errorType: null, errorMessage: '' };
  //     }

  //     DBG('validateFile: required file missing for', baseId);
  //     return {
  //       valid: false,
  //       errorType: 'required',
  //       errorMessage: getMessage(input, 'required', lang)
  //     };
  //   }

  //   // Local file selected → apply size/type rules

  //   if (file.size === 0) {
  //     DBG('validateFile: zero-byte file for', baseId);
  //     return {
  //       valid: false,
  //       errorType: 'zeroByte',
  //       errorMessage: getMessage(input, 'zero', lang)
  //     };
  //   }

  //   if (file.size > config.maxBytes) {
  //     const mb = (config.maxBytes / (1024 * 1024)).toFixed(1);
  //     let msg = getMessage(input, 'max', lang).replace('{MB}', mb);
  //     DBG('validateFile: file too large for', baseId, 'size=', file.size, 'maxBytes=', config.maxBytes);
  //     return {
  //       valid: false,
  //       errorType: 'maxSize',
  //       errorMessage: msg
  //     };
  //   }

  //   const name = String(file.name || '').trim();
  //   const dot = name.lastIndexOf('.');

  //   if (dot <= 0) {
  //     let msg = getMessage(input, 'type', lang).replace('{list}', config.allowedExt.join(', '));
  //     DBG('validateFile: file has no extension for', baseId, 'name=', name);
  //     return {
  //       valid: false,
  //       errorType: 'fileTypes',
  //       errorMessage: msg
  //     };
  //   }

  //   const ext = name.slice(dot + 1).toLowerCase();
  //   if (!config.allowedExt.includes(ext)) {
  //     let msg = getMessage(input, 'type', lang).replace('{list}', config.allowedExt.join(', '));
  //     DBG('validateFile: extension not allowed for', baseId, 'ext=', ext);
  //     return {
  //       valid: false,
  //       errorType: 'fileTypes',
  //       errorMessage: msg
  //     };
  //   }

  //   DBG('validateFile: file is valid for', baseId, 'name=', name, 'size=', file.size);
  //   return { valid: true, errorType: null, errorMessage: '' };
  // }


function validateFile(baseId, input, lang) {
  const config = getConfig(input);
  const file = input.files && input.files[0];

  // NEW: treat existing server-side file as satisfying "required"
  // when there is no local file selected.
  if (!file || input.files.length === 0) {
    if (hasExistingServerFile(baseId, input)) {
      DBG('validateFile: no local file, but existing server file detected for', baseId);
      return {
        valid: true,
        errorType: null,
        errorMessage: ''
      };
    }

    DBG('validateFile: no local or server file for', baseId);
    return {
      valid: false,
      errorType: 'required',
      errorMessage: getMessage(input, 'required', lang)
    };
  }

  // Zero-byte check
  if (file.size === 0) {
    DBG('validateFile: zero-byte file for', baseId);
    return {
      valid: false,
      errorType: 'zeroByte',
      errorMessage: getMessage(input, 'zero', lang)
    };
  }

  // Max-size check
  if (file.size > config.maxBytes) {
    const mb = (config.maxBytes / (1024 * 1024)).toFixed(1);
    let msg = getMessage(input, 'max', lang).replace('{MB}', mb);
    DBG('validateFile: file too large for', baseId, 'size=', file.size, 'maxBytes=', config.maxBytes);
    return {
      valid: false,
      errorType: 'maxSize',
      errorMessage: msg
    };
  }

  // Extension check
  const name = String(file.name || '').trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    let msg = getMessage(input, 'type', lang).replace('{list}', config.allowedExt.join(', '));
    DBG('validateFile: file has no extension for', baseId, 'name=', name);
    return {
      valid: false,
      errorType: 'fileTypes',
      errorMessage: msg
    };
  }

  const ext = name.slice(dot + 1).toLowerCase();
  if (!config.allowedExt.includes(ext)) {
    let msg = getMessage(input, 'type', lang).replace('{list}', config.allowedExt.join(', '));
    DBG('validateFile: extension not allowed for', baseId, 'ext=', ext);
    return {
      valid: false,
      errorType: 'fileTypes',
      errorMessage: msg
    };
  }

  DBG('validateFile: file is valid for', baseId, 'name=', name, 'size=', file.size);
  return { valid: true, errorType: null, errorMessage: '' };
}


  function createBridgeValidator(baseId) {
    const input = getFileInput(baseId);
    if (!input) return null;

    const validator = document.createElement('span');
    validator.id = `${baseId}_FileBridge_${Math.random().toString(36).substr(2, 9)}`;
    validator.controltovalidate = baseId;
    validator.isvalid = true;
    validator.type = 'file';
    validator.evaluationfunction = function (source) {
      const lang = getCurrentLang();
      const result = validateFile(baseId, input, lang);
      if (result.valid) {
        source.isvalid = true;
        source.errormessage = '';
        return true;
      } else {
        source.isvalid = false;
        source.errormessage =
          `<a href='#${baseId}_label' onclick='javascript:scrollToAndFocus("${baseId}_label","${baseId}"); return false;' referenceControlId=${baseId}>${result.errorMessage}</a>`;
        return false;
      }
    };
    return validator;
  }

  function addBridgeValidatorLast(baseId) {
    // Idempotency: avoid inserting duplicate bridge validators for the same field.
    try {
      if (window.Page_Validators && window.Page_Validators.some(function (v) {
        return v && v.controltovalidate === baseId && typeof v.id === 'string' && v.id.indexOf(baseId + '_FileBridge_') === 0;
      })) {
        DBG('Bridge already present (skip insert) for', baseId);
        return;
      }
    } catch (_) {}

    const bridge = createBridgeValidator(baseId);
    if (!bridge) return;

    if (!window.Page_Validators) window.Page_Validators = [];
    const indices = window.Page_Validators
      .map((v, i) => ({ v, i }))
      .filter(x => x.v && x.v.controltovalidate === baseId)
      .map(x => x.i);
    if (indices.length > 0) {
      const lastIdx = indices[indices.length - 1];
      window.Page_Validators.splice(lastIdx + 1, 0, bridge);
      DBG('Bridge inserted after index', lastIdx);
    } else {
      window.Page_Validators.push(bridge);
      DBG('Bridge appended (no prior validators for base)', baseId);
    }
  }

  function baseFromInput(el) {
    return String(el && el.id || '')
      .replace(/_input_file$/i, '')
      .replace(/hidden_(filename|filetype|file_size)$/i, '');
  }


// 
function register(baseId) {
  baseId = String(baseId || '').trim();
  if (!baseId) return function () {};

  // Track enabled field + ensure we re-bind after partial postbacks
  try { enabledBaseIds.add(baseId); } catch (_) {}
  try { ensureEndRequestHook(); } catch (_) {}
  try { ensureDeleteClickHook(); } catch (_) {}

  // Ensure our bridge validator is appended after any stock validators
  try { if (typeof addBridgeValidatorLast === 'function') addBridgeValidatorLast(baseId); } catch (_) {}

  // Resolve PP native input
  var input = document.getElementById(baseId + '_input_file') || document.getElementById(baseId);
  if (!input) return function () {};

  // Reconcile delete button state (PP can leave it visible after a delete partial postback)
  try { syncDeleteButtonVisibility(baseId); } catch (_) {}

  // Unhook prior handlers (if any)
  if (input.__wetBridgeHandlers) {
    try {
      var old = input.__wetBridgeHandlers;
      input.removeEventListener('invalid', old.invalid, true);
      input.removeEventListener('change',  old.change,  false);
      input.removeEventListener('blur',    old.blur,    false);
    } catch (_) {}
  }

  // // invalid: capture=true so we can suppress the browser bubble; no stopPropagation
  // function onInvalid(e) {
  //   if (e && e.preventDefault) e.preventDefault(); // kill native tooltip
  //   try {
  //     if (typeof updatesOnChange === 'function') updatesOnChange({ id: baseId, type: 'file' }, e || new Event('synthetic'));
  //     if (typeof globalEvaluationFunction === 'function') globalEvaluationFunction();
  //     if (typeof ValidatorUpdateIsValid === 'function') ValidatorUpdateIsValid();
  //   } catch (_) {}
  // }

  // // change/blur: bubble phase; no stopPropagation; defer so PP/your relabeler run first
  // function onChangeLike(e) {
  //   setTimeout(function () {
  //     try {
  //       if (typeof updatesOnChange === 'function') updatesOnChange({ id: baseId, type: 'file' }, e || new Event('synthetic'));
  //       if (typeof globalEvaluationFunction === 'function') globalEvaluationFunction();
  //       if (typeof ValidatorUpdateIsValid === 'function') ValidatorUpdateIsValid();
  //     } catch (_) {}
  //   }, 0);
  // }

  // // Attach with correct phases
  // input.addEventListener('invalid', onInvalid, true);  // CAPTURE
  // input.addEventListener('change',  onChangeLike, false); // BUBBLE
  // input.addEventListener('blur',    onChangeLike, false); // BUBBLE

  // fileNativeBridge.js  — inside register(baseId)

/* helper */
function validatorsActive() {
  return !!(window.__validators_active);
}

// invalid: capture=true so we can suppress the browser bubble; remain quiet pre-activation
function onInvalid(e) {
  if (e && e.preventDefault) e.preventDefault();    // kill native tooltip
  if (e && e.stopPropagation) e.stopPropagation();  // keep it from bubbling
  if (!validatorsActive()) return;                  // <-- QUIET until first Next

  try {
    if (typeof updatesOnChange === 'function')
      updatesOnChange({ id: baseId, type: 'file' }, e || new Event('synthetic'));
    if (typeof globalEvaluationFunction === 'function')
      globalEvaluationFunction();
    if (typeof ValidatorUpdateIsValid === 'function')
      ValidatorUpdateIsValid();
  } catch (_) {}
}

// change/blur: allow filename relabel to run; only validate once active
function onChangeLike(e) {
  setTimeout(function () {
    if (!validatorsActive()) return;                // <-- QUIET until first Next
    try {
      if (typeof updatesOnChange === 'function')
        updatesOnChange({ id: baseId, type: 'file' }, e || new Event('synthetic'));
      if (typeof globalEvaluationFunction === 'function')
        globalEvaluationFunction();
      if (typeof ValidatorUpdateIsValid === 'function')
        ValidatorUpdateIsValid();
    } catch (_) {}
  }, 0);
}

// Attach with correct phases (unchanged)
input.addEventListener('invalid', onInvalid,  true);   // CAPTURE
input.addEventListener('change',  onChangeLike, false);
input.addEventListener('blur',    onChangeLike, false);

  // Mark & expose unhook
  input.__wetBridgeHandlers = { invalid: onInvalid, change: onChangeLike, blur: onChangeLike };

  try { input.setAttribute('data-wet-bridge', '1'); } catch (_) {}
  try { if (typeof suppressStockFileErrors === 'function') suppressStockFileErrors([baseId]); } catch (_) {}

  return function unhook() {
    try {
      input.removeEventListener('invalid', onInvalid, true);
      input.removeEventListener('change',  onChangeLike, false);
      input.removeEventListener('blur',    onChangeLike, false);
    } catch (_) {}
    try { delete input.__wetBridgeHandlers; } catch (_) {}
  };
}


  function unregister(baseId) {
    try { enabledBaseIds.delete(baseId); } catch (_) {}
    const input = getFileInput(baseId);
    if (input) delete input.dataset.bridgeRegistered;

    if (window.Page_Validators) {
      const re = new RegExp(`^${baseId}_FileBridge_`);
      for (let i = window.Page_Validators.length - 1; i >= 0; i--) {
        const v = window.Page_Validators[i];
        if (v && v.controltovalidate === baseId && re.test(v.id)) {
          window.Page_Validators.splice(i, 1);
        }
      }
    }
    LOG('Unregistered', baseId);
  }


window.FileNativeBridge = window.FileNativeBridge || {};

// Enable bridge for one field base id (returns an unhook fn if you need it)
window.FileNativeBridge.enableForField = function enableForField(baseId) {
  return register(String(baseId || '').trim());
};

// Convenience for multiple
window.FileNativeBridge.enableForFields = function enableForFields(bases) {
  (bases || []).forEach(function (b) { register(String(b || '').trim()); });
};

// Optional: explicit disable
window.FileNativeBridge.disableForField = function disableForField(baseId) {
  unregister(String(baseId || '').trim());
};

  function registerWithinForm(form) {
    if (!form) return 0;
    let count = 0;
    const inputs = form.querySelectorAll('input[type="file"][id$="_input_file"]');
    inputs.forEach(inp => { const base = inp.id.replace(/_input_file$/, ''); register(base); count++; });
    return count;
  }

  // Public API
  window.FileStockSuppression = window.FileStockSuppression || {};
  window.FileStockSuppression.register = register;
  window.FileStockSuppression.unregister = unregister;

  // Programmatic opt-in APIs
  window.FileStockSuppression.enableForForm = function (formSelectorOrEl) {
    const form = typeof formSelectorOrEl === 'string'
      ? document.querySelector(formSelectorOrEl)
      : formSelectorOrEl;
    if (!form) return 0;
    optedInForms.add(form);
    return registerWithinForm(form);
  };
  window.FileStockSuppression.registerForm = window.FileStockSuppression.enableForForm;

  window.FileStockSuppression.enableForField = function (baseId) {
    if (!baseId) return 0;
    optedInFields.add(baseId);
    register(baseId);
    return 1;
  };

  // NEW helper: allow other modules to check if a server-side file exists
  window.FileStockSuppression.hasExistingServerFile = function (baseId) {
    const input = getFileInput(baseId);
    if (!input) return false;
    try {
      return hasExistingServerFile(baseId, input);
    } catch (e) {
      DBG('hasExistingServerFile wrapper: error for', baseId, e);
      return false;
    }
  };

  window.FileStockSuppression.unregisterAll = function () {
    document.querySelectorAll('input[type="file"][id$="_input_file"]').forEach(inp => {
      unregister(inp.id.replace(/_input_file$/, ''));
    });
  };

  // Optional bootstrap via window.FILE_BRIDGE_CFG (define before this script loads)
  function bootstrapFromConfig() {
    const cfg = window.FILE_BRIDGE_CFG;
    if (!cfg) return;
    try {
      const forms = Array.isArray(cfg.includeForms) ? cfg.includeForms : [];
      const fields = Array.isArray(cfg.includeFields) ? cfg.includeFields : [];
      forms.forEach(sel => { try { window.FileStockSuppression.enableForForm(sel); } catch (e) { DBG('bootstrap form fail', sel, e); } });
      fields.forEach(base => { try { window.FileStockSuppression.enableForField(base); } catch (e) { DBG('bootstrap field fail', base, e); } });
      if (forms.length || fields.length) LOG('Bootstrapped from FILE_BRIDGE_CFG', { forms: forms.length, fields: fields.length });
    } catch (e) { DBG('bootstrap error', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapFromConfig, { once: true });
  } else {
    bootstrapFromConfig();
  }

  LOG('File native bridge (programmatic-only) loaded');
})(window);