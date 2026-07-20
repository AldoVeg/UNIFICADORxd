/* ═══════════════════════════════════════════════
   index.js — UNIFICADOR SEDAPAL (Fortificado v3)
   IIFE estricto · Foleo normal + inverso · Memoria
   controlada · Selección múltiple · Atajos teclado
   ═══════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Guard: DOM aún no listo ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {

    /* ── Validación de CDNs ── */
    if (typeof pdfjsLib === 'undefined') {
      var banner = document.getElementById('cdn-error');
      if (banner) banner.classList.remove('hidden');
      return;
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

    if (typeof PDFLib === 'undefined') {
      var banner2 = document.getElementById('cdn-error');
      if (banner2) banner2.classList.remove('hidden');
      return;
    }

    /* ── Referencias DOM cacheadas ── */
    var DOM = {
      workspace:        document.getElementById('workspace'),
      btnGenerate:      document.getElementById('btn-generate'),
      overlay:          document.getElementById('loading-overlay'),
      loadingText:      document.getElementById('loading-text'),
      progressBar:      document.getElementById('progress-bar'),
      dropZone:         document.getElementById('drop-zone'),
      fileInput:        document.getElementById('file-input'),
      chkFoleo:         document.getElementById('chk-foleo'),
      chkFoleoInverso:  document.getElementById('chk-foleo-inverso'),
      lblFoleoInverso:  document.getElementById('lbl-foleo-inverso'),
      chkOptimize:      document.getElementById('chk-optimize'),
      folioStart:       document.getElementById('folio-start'),
      currentYear:      document.getElementById('current-year')
    };

    /* ── Estado interno ── */
    var pdfDocumentsData = new Map();   // fileId → ArrayBuffer
    var pageRegistry = [];              // [{ id, fileId, pageIndex, rotation, thumb }]
    var revokedUrls = new Set();        // tracking de ObjectURLs

    /* ── Año dinámico en footer ── */
    if (DOM.currentYear) {
      DOM.currentYear.textContent = new Date().getFullYear();
    }

    /* ── Generador de IDs ── */
    function generateId() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    /* ═══════════════════════════════════════════════
       TOAST / LOADER / PROGRESS
       ═══════════════════════════════════════════════ */

    function showToast(msg, type) {
      var container = document.getElementById('toast-container');
      if (!container) return;
      var toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = msg;
      toast.addEventListener('click', function () {
        toast.classList.add('toast-out');
        setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
      });
      container.appendChild(toast);
      setTimeout(function () {
        if (toast.parentNode) {
          toast.classList.add('toast-out');
          setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
        }
      }, 5000);
    }

    function showLoader(msg, withProgress) {
      if (!DOM.overlay) return;
      DOM.loadingText.textContent = msg || 'Procesando...';
      DOM.overlay.classList.remove('hidden');
      if (withProgress) {
        DOM.progressBar.classList.remove('hidden');
        DOM.progressBar.value = 0;
      } else {
        DOM.progressBar.classList.add('hidden');
      }
    }

    function updateProgress(current, total) {
      if (!DOM.progressBar || DOM.progressBar.classList.contains('hidden')) return;
      DOM.progressBar.value = Math.round((current / total) * 100);
    }

    function hideLoader() {
      if (!DOM.overlay) return;
      DOM.overlay.classList.add('hidden');
      DOM.progressBar.classList.add('hidden');
    }

    /* ── Timeout de seguridad para el loader ── */
    var loaderTimeout = null;
    function startLoaderTimeout() {
      clearLoaderTimeout();
      loaderTimeout = setTimeout(function () {
        hideLoader();
        showToast('La operación está tardando más de lo esperado. Verifica tus archivos.', 'warning');
      }, 90000);
    }
    function clearLoaderTimeout() {
      if (loaderTimeout) { clearTimeout(loaderTimeout); loaderTimeout = null; }
    }

    /* ═══════════════════════════════════════════════
       VALIDACIÓN DE MAGIC BYTES (%PDF)
       ═══════════════════════════════════════════════ */

    function isValidPDF(buffer) {
      if (!buffer || buffer.byteLength < 5) return false;
      var arr = new Uint8Array(buffer);
      return arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46; // %PDF
    }

    /* ═══════════════════════════════════════════════
       SINCRONIZACIÓN REGISTRO ↔ DOM
       ═══════════════════════════════════════════════ */

    function syncRegistryWithDOM() {
      var newOrder = [];
      Array.from(DOM.workspace.children).forEach(function (card) {
        var record = pageRegistry.find(function (p) { return p.id === card.dataset.id; });
        if (record) newOrder.push(record);
      });
      pageRegistry = newOrder;
      DOM.btnGenerate.disabled = pageRegistry.length === 0;

      // Limpiar documentos huérfanos
      var activeFileIds = new Set(pageRegistry.map(function (p) { return p.fileId; }));
      pdfDocumentsData.forEach(function (_, fileId) {
        if (!activeFileIds.has(fileId)) pdfDocumentsData.delete(fileId);
      });
    }

    /* ═══════════════════════════════════════════════
       CREACIÓN DE TARJETAS EN EL DOM
       ═══════════════════════════════════════════════ */

    function createCardInDOM(data) {
      var card = document.createElement('div');
      card.className = 'page-card';
      card.dataset.id = data.id;
      card.tabIndex = 0;

      // Selección múltiple con clic
      card.addEventListener('click', function (e) {
        if (e.target.classList.contains('btn-delete-page')) return;
        card.classList.toggle('selected');
      });

      // Botón de borrado individual
      var btnDel = document.createElement('button');
      btnDel.className = 'btn-delete-page';
      btnDel.innerHTML = '✖';
      btnDel.setAttribute('aria-label', 'Eliminar página');
      btnDel.onclick = function (e) {
        e.stopPropagation();
        var selected = document.querySelectorAll('.page-card.selected');
        if (selected.length > 0 && card.classList.contains('selected')) {
          selected.forEach(function (c) { c.remove(); });
        } else {
          card.remove();
        }
        syncRegistryWithDOM();
      };

      // Imagen miniatura
      var img = document.createElement('img');
      img.className = 'page-image';
      img.src = data.thumb;
      img.dataset.rotation = 0;
      img.alt = 'Miniatura de página';

      // Rotación con doble clic
      card.ondblclick = function (e) {
        e.stopPropagation();
        var currentRot = (parseInt(img.dataset.rotation, 10) + 90) % 360;
        img.dataset.rotation = currentRot;
        img.style.transform = 'rotate(' + currentRot + 'deg)';

        var regIndex = pageRegistry.findIndex(function (p) { return p.id === data.id; });
        if (regIndex > -1) pageRegistry[regIndex].rotation = currentRot;
      };

      card.appendChild(btnDel);
      card.appendChild(img);
      DOM.workspace.appendChild(card);
    }

    /* ═══════════════════════════════════════════════
       TARJETA DE PÁGINA FALLIDA
       ═══════════════════════════════════════════════ */

    function createFailedCard(fileId, pageNum) {
      var card = document.createElement('div');
      card.className = 'page-card page-failed';
      card.dataset.id = generateId();
      card.tabIndex = 0;
      card.title = 'Página ' + pageNum + ' — Error al renderizar';

      var icon = document.createElement('span');
      icon.className = 'failed-icon';
      icon.textContent = '⚠️';

      var label = document.createElement('span');
      label.className = 'failed-label';
      label.textContent = 'Pág. ' + pageNum;

      var btnDel = document.createElement('button');
      btnDel.className = 'btn-delete-page';
      btnDel.innerHTML = '✖';
      btnDel.setAttribute('aria-label', 'Eliminar página fallida');
      btnDel.onclick = function (e) {
        e.stopPropagation();
        card.remove();
        syncRegistryWithDOM();
      };

      card.appendChild(btnDel);
      card.appendChild(icon);
      card.appendChild(label);
      DOM.workspace.appendChild(card);
    }

    /* ═══════════════════════════════════════════════
       PROCESAMIENTO DE ARCHIVOS PDF
       ═══════════════════════════════════════════════ */

    async function processFiles(files) {
      var pdfs = Array.from(files).filter(function (f) {
        return f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
      });

      if (pdfs.length === 0) {
        showToast('Por favor, sube únicamente archivos en formato PDF.', 'warning');
        return;
      }

      showLoader('Procesando páginas...', true);
      startLoaderTimeout();
      DOM.btnGenerate.disabled = true;

      for (var f = 0; f < pdfs.length; f++) {
        var file = pdfs[f];
        var fileId = generateId();
        var buffer;

        try {
          buffer = await file.arrayBuffer();
        } catch (err) {
          showToast('Error al leer: ' + file.name, 'error');
          continue;
        }

        if (!isValidPDF(buffer)) {
          showToast(file.name + ' no es un PDF válido. Se omitirá.', 'warning');
          continue;
        }

        pdfDocumentsData.set(fileId, buffer);

        var loadingTask = null;
        var pdf = null;

        try {
          loadingTask = pdfjsLib.getDocument({ data: buffer.slice(0) });
          pdf = await loadingTask.promise;
          var totalPages = pdf.numPages;

          for (var i = 1; i <= totalPages; i++) {
            updateProgress(i, totalPages);

            // Micro-pausa cada 5 páginas para liberar el event loop
            if (i % 5 === 0) await new Promise(function (r) { return setTimeout(r, 1); });

            var pageId = fileId + '_' + i;

            try {
              var page = await pdf.getPage(i);
              var viewport = page.getViewport({ scale: 0.15 });
              var canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              var ctx = canvas.getContext('2d');
              await page.render({ canvasContext: ctx, viewport: viewport }).promise;

              var thumb = canvas.toDataURL('image/jpeg', 0.5);

              // Liberar canvas
              canvas.width = 0;
              canvas.height = 0;

              var nodeData = {
                id: pageId,
                fileId: fileId,
                pageIndex: i - 1,
                rotation: 0,
                thumb: thumb
              };

              pageRegistry.push(nodeData);
              createCardInDOM(nodeData);

            } catch (pageErr) {
              console.warn('Error en página ' + i + ' de ' + file.name + ':', pageErr);
              createFailedCard(fileId, i);
            }
          }
        } catch (docErr) {
          console.error('Error al abrir PDF ' + file.name + ':', docErr);
          showToast('No se pudo procesar: ' + file.name, 'error');
        } finally {
          // Liberar recursos de pdf.js
          if (pdf && typeof pdf.destroy === 'function') {
            try { pdf.destroy(); } catch (e) { /* silencioso */ }
          }
          if (loadingTask && typeof loadingTask.destroy === 'function') {
            try { loadingTask.destroy(); } catch (e) { /* silencioso */ }
          }
        }
      }

      DOM.btnGenerate.disabled = pageRegistry.length === 0;
      clearLoaderTimeout();
      hideLoader();
      DOM.fileInput.value = '';
    }

    /* ═══════════════════════════════════════════════
       GENERACIÓN DEL PDF UNIFICADO
       ═══════════════════════════════════════════════ */

    async function generatePDF() {
      if (pageRegistry.length === 0) return;

      showLoader('Compilando documento final...', true);
      startLoaderTimeout();

      var applyFoleo        = DOM.chkFoleo ? DOM.chkFoleo.checked : false;
      var applyFoleoInverso = applyFoleo && DOM.chkFoleoInverso ? DOM.chkFoleoInverso.checked : false;
      var optimize          = DOM.chkOptimize ? DOM.chkOptimize.checked : true;
      var folioNum          = parseInt(DOM.folioStart.value, 10) || 1;
      var totalPages        = pageRegistry.length;

      // ── Cálculo de folio inicial para modo inverso ──
      // En modo inverso, la última página recibe el número más bajo (folioNum)
      // y la primera página recibe el número más alto (folioNum + totalPages - 1)
      var folioActual;
      if (applyFoleoInverso) {
        // Empezamos desde el número más alto y decrementamos
        folioActual = folioNum + totalPages - 1;
      } else {
        folioActual = folioNum;
      }

      try {
        var finalPdf = await PDFLib.PDFDocument.create();
        var loadedDocs = new Map();

        // Cargar cada documento fuente una sola vez
        for (var _i = 0, _keys = Array.from(pdfDocumentsData.keys()); _i < _keys.length; _i++) {
          var fileId = _keys[_i];
          var buffer = pdfDocumentsData.get(fileId);
          loadedDocs.set(fileId, await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true }));
        }

        var font = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);

        for (var i = 0; i < totalPages; i++) {
          updateProgress(i, totalPages);

          // Chunking cada 10 páginas
          if (i % 10 === 0) await new Promise(function (r) { return setTimeout(r, 1); });

          var req = pageRegistry[i];
          var srcDoc = loadedDocs.get(req.fileId);
          if (!srcDoc) continue;

          var copiedPages;
          try {
            copiedPages = await finalPdf.copyPages(srcDoc, [req.pageIndex]);
          } catch (copyErr) {
            console.warn('Error al copiar página ' + (i + 1) + ':', copyErr);
            continue;
          }

          var copiedPage = copiedPages[0];

          if (req.rotation !== 0) {
            var currentRot = copiedPage.getRotation().angle;
            copiedPage.setRotation(PDFLib.degrees(currentRot + req.rotation));
          }

          finalPdf.addPage(copiedPage);

          // ── FOLEO (normal o inverso) ──
          if (applyFoleo) {
            var fStr = String(folioActual).padStart(3, '0');
            var size = copiedPage.getSize();
            var pageWidth = size.width;
            var pageHeight = size.height;

            // Rectángulo blanco de fondo
            copiedPage.drawRectangle({
              x: pageWidth - 40,
              y: pageHeight - 25,
              width: 30,
              height: 16,
              color: PDFLib.rgb(1, 1, 1)
            });

            // Número de folio
            copiedPage.drawText(fStr, {
              x: pageWidth - 36,
              y: pageHeight - 21,
              size: 11,
              font: font,
              color: PDFLib.rgb(0, 0, 0)
            });

            // Avanzar o retroceder según el modo
            if (applyFoleoInverso) {
              folioActual--;  // Decrementa: última página = número más bajo
            } else {
              folioActual++;  // Incrementa: primera página = número más bajo
            }
          }
        }

        var saveOptions = optimize ? { useObjectStreams: true } : {};
        var finalBytes = await finalPdf.save(saveOptions);

        var blob = new Blob([finalBytes], { type: 'application/pdf' });
        var url = URL.createObjectURL(blob);
        revokedUrls.add(url);

        var link = document.createElement('a');
        link.href = url;
        link.download = 'SEDAPAL_Unificado_' + new Date().toISOString().split('T')[0] + '.pdf';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Revocar después de un tiempo prudencial
        setTimeout(function () {
          URL.revokeObjectURL(url);
          revokedUrls.delete(url);
        }, 3000);

        showToast('PDF unificado generado exitosamente.', 'success');

      } catch (e) {
        console.error('Error en unificación:', e);
        showToast('Error crítico durante la unificación: ' + e.message, 'error');
      } finally {
        clearLoaderTimeout();
        hideLoader();
      }
    }

    /* ═══════════════════════════════════════════════
       EVENT LISTENERS
       ═══════════════════════════════════════════════ */

    // ── Zona de carga ──
    DOM.dropZone.addEventListener('click', function () { DOM.fileInput.click(); });

    ['dragover', 'dragenter'].forEach(function (evName) {
      DOM.dropZone.addEventListener(evName, function (ev) {
        ev.preventDefault();
        DOM.dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(function (evName) {
      DOM.dropZone.addEventListener(evName, function (ev) {
        ev.preventDefault();
        DOM.dropZone.classList.remove('drag-over');
      });
    });

    DOM.dropZone.addEventListener('drop', function (ev) { processFiles(ev.dataTransfer.files); });
    DOM.fileInput.addEventListener('change', function (ev) { processFiles(ev.target.files); });

    // ── Mostrar/ocultar checkbox de foleo inverso ──
    if (DOM.chkFoleo && DOM.lblFoleoInverso) {
      DOM.chkFoleo.addEventListener('change', function () {
        DOM.lblFoleoInverso.style.display = this.checked ? '' : 'none';
        if (!this.checked && DOM.chkFoleoInverso) {
          DOM.chkFoleoInverso.checked = false;
        }
      });
    }

    // ── Atajos de teclado ──
    document.addEventListener('keydown', function (e) {
      // No interceptar cuando el foco está en un input/select/textarea
      var tag = document.activeElement ? document.activeElement.tagName : '';
      var isEditable = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
                       (document.activeElement && document.activeElement.isContentEditable);

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditable) return;
        var selected = document.querySelectorAll('.page-card.selected');
        if (selected.length > 0) {
          selected.forEach(function (card) { card.remove(); });
          syncRegistryWithDOM();
          e.preventDefault();
        }
      }

      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        if (isEditable) return;
        e.preventDefault();
        var allCards = document.querySelectorAll('.page-card:not(.page-failed)');
        allCards.forEach(function (card) { card.classList.add('selected'); });
      }

      if (e.key === 'Escape') {
        var allSelected = document.querySelectorAll('.page-card.selected');
        allSelected.forEach(function (card) { card.classList.remove('selected'); });
      }
    });

    // ── SortableJS (arrastre visual) ──
    if (typeof Sortable !== 'undefined') {
      try {
        new Sortable(DOM.workspace, {
          animation: 150,
          ghostClass: 'sortable-ghost',
          chosenClass: 'sortable-chosen',
          delay: 100,
          delayOnTouchOnly: true,
          onEnd: function () { syncRegistryWithDOM(); }
        });
      } catch (sortErr) {
        console.warn('SortableJS no pudo inicializarse. El orden manual por arrastre no estará disponible.', sortErr);
      }
    }

    // ── Botón generar ──
    DOM.btnGenerate.addEventListener('click', generatePDF);

    // ── Limpieza de ObjectURLs al salir ──
    window.addEventListener('beforeunload', function () {
      revokedUrls.forEach(function (url) {
        try { URL.revokeObjectURL(url); } catch (e) { /* silencioso */ }
      });
      revokedUrls.clear();
    });

    console.log('✅ UNIFICADOR SEDAPAL — inicializado correctamente.');
  }

})();
