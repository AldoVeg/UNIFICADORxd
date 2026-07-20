 /* ═══════════════════════════════════════════════
   index.js — UNIFICADOR SEDAPAL (Fortificado v4)
   IIFE estricto · MultiDrag nativo · Foleo inverso
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

    /* ── Validación del motor PDF.js ── */
    if (typeof pdfjsLib === 'undefined') {
      var banner = document.getElementById('cdn-error');
      if (banner) banner.classList.remove('hidden');
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

    /* ── Referencias DOM cacheadas ── */
    var workspace   = document.getElementById('workspace');
    var btnGenerate = document.getElementById('btn-generate');
    var overlay     = document.getElementById('loading-overlay');
    var textStatus  = document.getElementById('loading-text');
    var progressBar = document.getElementById('progress-bar');
    var dropZone    = document.getElementById('drop-zone');
    var fileInput   = document.getElementById('file-input');
    var chkFoleo    = document.getElementById('chk-foleo');
    var chkFoleoInv = document.getElementById('chk-foleo-inverso');
    var folioStart  = document.getElementById('folio-start');
    var chkOptimize = document.getElementById('chk-optimize');

    /* ── Estado interno ── */
    var pdfDocumentsData = new Map();
    var pageRegistry     = [];
    var revokedUrls      = new Set();

    function generateId() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    }

    /* ═══════════════════════════════════════════════
       SORTABLE CON MULTIDRAG NATIVO
       ═══════════════════════════════════════════════ */

    // Montar el plugin MultiDrag (incluido en sortablejs@latest)
    if (typeof Sortable !== 'undefined' && Sortable.MultiDrag) {
      Sortable.mount(new Sortable.MultiDrag());
    }

    try {
      new Sortable(workspace, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        delay: 100,
        delayOnTouchOnly: true,

        // ── MultiDrag nativo ──
        multiDrag: true,
        selectedClass: 'selected',
        // Sin multiDragKey: clic simple selecciona/deselecciona
        // Shift+Click para rango, Ctrl+Click para añadir/quitar

        onEnd: function () {
          syncRegistryWithDOM();
        }
      });
    } catch (e) {
      console.warn('SortableJS no disponible — la app funciona sin arrastre.');
    }

    /* ═══════════════════════════════════════════════
       EVENTOS DE CARGA DE ARCHIVOS
       ═══════════════════════════════════════════════ */

    dropZone.addEventListener('click', function () { fileInput.click(); });

    ['dragover', 'dragenter'].forEach(function (evName) {
      dropZone.addEventListener(evName, function (e) {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(function (evName) {
      dropZone.addEventListener(evName, function (e) {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
      });
    });

    dropZone.addEventListener('drop', function (e) {
      processFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', function (e) {
      processFiles(e.target.files);
    });

    /* ═══════════════════════════════════════════════
       TECLADO: Supr/Escape/Ctrl+A
       ═══════════════════════════════════════════════ */
    document.addEventListener('keydown', function (e) {
      // No interceptar si el foco está en un input/select
      var tag = document.activeElement ? document.activeElement.tagName : '';
      var isEditable = (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA');

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditable) return;
        var selected = workspace.querySelectorAll('.page-card.selected');
        if (selected.length > 0) {
          selected.forEach(function (card) { card.remove(); });
          syncRegistryWithDOM();
          e.preventDefault();
        }
      }

      if (e.key === 'Escape') {
        workspace.querySelectorAll('.page-card.selected').forEach(function (c) {
          c.classList.remove('selected');
        });
      }

      if (e.ctrlKey && e.key === 'a') {
        if (isEditable) return;
        e.preventDefault();
        Array.from(workspace.children).forEach(function (card) {
          card.classList.add('selected');
        });
      }
    });

    /* ═══════════════════════════════════════════════
       MOSTRAR/OCULTAR FOLEO INVERSO
       ═══════════════════════════════════════════════ */
    if (chkFoleo && chkFoleoInv) {
      chkFoleo.addEventListener('change', function () {
        if (this.checked) {
          chkFoleoInv.parentElement.style.display = '';
        } else {
          chkFoleoInv.parentElement.style.display = 'none';
          chkFoleoInv.checked = false;
        }
      });
    }

    /* ═══════════════════════════════════════════════
       PROCESAR ARCHIVOS PDF
       ═══════════════════════════════════════════════ */
    function isValidPDF(buffer) {
      if (buffer.byteLength < 5) return false;
      var arr = new Uint8Array(buffer, 0, 5);
      return arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46; // %PDF
    }

    async function processFiles(files) {
      var pdfs = Array.from(files).filter(function (f) {
        return f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
      });

      if (pdfs.length === 0) {
        showToast('Por favor, sube únicamente archivos en formato PDF.', 'error');
        return;
      }

      showLoader('Procesando páginas...', true);
      btnGenerate.disabled = true;

      for (var f = 0; f < pdfs.length; f++) {
        var file = pdfs[f];
        var fileId = generateId();
        var buffer = await file.arrayBuffer();

        if (!isValidPDF(buffer)) {
          showToast('El archivo "' + file.name + '" no es un PDF válido. Se omitió.', 'warning');
          continue;
        }

        pdfDocumentsData.set(fileId, buffer);

        try {
          var loadingTask = pdfjsLib.getDocument({ data: buffer });
          var pdf = await loadingTask.promise;
          var totalPages = pdf.numPages;

          for (var i = 1; i <= totalPages; i++) {
            updateProgress(i, totalPages);

            if (i % 5 === 0) await new Promise(function (r) { setTimeout(r, 1); });

            var pageId = fileId + '_' + i;

            try {
              var page = await pdf.getPage(i);
              var viewport = page.getViewport({ scale: 0.15 });
              var canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              await page.render({
                canvasContext: canvas.getContext('2d'),
                viewport: viewport
              }).promise;

              var nodeData = {
                id: pageId,
                fileId: fileId,
                pageIndex: i - 1,
                rotation: 0,
                thumb: canvas.toDataURL('image/jpeg', 0.5)
              };

              canvas.width = 0;
              canvas.height = 0;

              pageRegistry.push(nodeData);
              createCardInDOM(nodeData);
            } catch (pageErr) {
              console.error('Error en página ' + i + ' de ' + file.name + ':', pageErr);
              createFailedCard(fileId, i, file.name);
            }
          }

          await pdf.destroy();
          await loadingTask.destroy();
        } catch (docErr) {
          console.error('Error al leer el PDF ' + file.name + ':', docErr);
          showToast('No se pudo leer "' + file.name + '". Puede estar corrupto.', 'error');
        }
      }

      btnGenerate.disabled = pageRegistry.length === 0;
      hideLoader();
      fileInput.value = '';

      if (pageRegistry.length === 0 && pdfDocumentsData.size > 0) {
        pdfDocumentsData.clear();
      }
    }

    /* ═══════════════════════════════════════════════
       TARJETAS EN EL DOM
       ═══════════════════════════════════════════════ */

    function createCardInDOM(data) {
      var card = document.createElement('div');
      card.className = 'page-card';
      card.dataset.id = data.id;

      // ── NOTA: El clic para seleccionar/deseleccionar lo maneja MultiDrag nativo ──
      // No se agrega listener de click manual — Sortable con selectedClass: 'selected' lo gestiona

      var btnDel = document.createElement('button');
      btnDel.className = 'btn-delete-page';
      btnDel.innerHTML = '&#10006;';
      btnDel.setAttribute('aria-label', 'Eliminar página');
      btnDel.onclick = function (e) {
        e.stopPropagation();
        e.preventDefault();

        var selected = workspace.querySelectorAll('.page-card.selected');
        if (selected.length > 0 && card.classList.contains('selected')) {
          selected.forEach(function (c) { c.remove(); });
        } else {
          card.remove();
        }
        syncRegistryWithDOM();
      };

      var img = document.createElement('img');
      img.className = 'page-image';
      img.src = data.thumb;
      img.dataset.rotation = '0';
      img.draggable = false;

      // Rotación con doble clic
      card.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        var currentRot = (parseInt(img.dataset.rotation, 10) + 90) % 360;
        img.dataset.rotation = currentRot;
        img.style.transform = 'rotate(' + currentRot + 'deg)';

        var regIndex = pageRegistry.findIndex(function (p) { return p.id === data.id; });
        if (regIndex > -1) pageRegistry[regIndex].rotation = currentRot;
      });

      card.appendChild(btnDel);
      card.appendChild(img);
      workspace.appendChild(card);
    }

    function createFailedCard(fileId, pageNum, fileName) {
      var card = document.createElement('div');
      card.className = 'page-card page-failed';
      card.dataset.id = fileId + '_failed_' + pageNum;
      card.title = 'Página ' + pageNum + ' de ' + fileName + ' — Error al renderizar';

      var icon = document.createElement('span');
      icon.style.cssText = 'font-size:28px;';
      icon.textContent = '\u26A0\uFE0F';

      var label = document.createElement('span');
      label.style.cssText = 'font-size:10px;color:#e03131;text-align:center;padding:4px;';
      label.textContent = 'Pág ' + pageNum + '\nError';

      var btnDel = document.createElement('button');
      btnDel.className = 'btn-delete-page';
      btnDel.innerHTML = '&#10006;';
      btnDel.setAttribute('aria-label', 'Eliminar');
      btnDel.onclick = function (e) {
        e.stopPropagation();
        e.preventDefault();
        card.remove();
        syncRegistryWithDOM();
      };

      card.appendChild(btnDel);
      card.appendChild(icon);
      card.appendChild(label);
      workspace.appendChild(card);
    }

    function syncRegistryWithDOM() {
      var newOrder = [];
      Array.from(workspace.children).forEach(function (card) {
        var record = pageRegistry.find(function (p) { return p.id === card.dataset.id; });
        if (record) newOrder.push(record);
      });
      pageRegistry = newOrder;
      btnGenerate.disabled = pageRegistry.length === 0;

      // Limpiar documentos huérfanos
      if (pageRegistry.length === 0) {
        pdfDocumentsData.clear();
      }
    }

    /* ═══════════════════════════════════════════════
       GENERACIÓN DEL PDF UNIFICADO
       ═══════════════════════════════════════════════ */
    btnGenerate.addEventListener('click', async function () {
      if (pageRegistry.length === 0) return;

      showLoader('Compilando documento final...', true);
      var applyFoleo    = chkFoleo ? chkFoleo.checked : false;
      var applyInv      = chkFoleoInv ? chkFoleoInv.checked : false;
      var optimize      = chkOptimize ? chkOptimize.checked : true;
      var folioNum      = folioStart ? (parseInt(folioStart.value, 10) || 1) : 1;
      var totalPages    = pageRegistry.length;

      // Si foleo inverso: la primera página recibe el número más alto
      var folioActual;
      if (applyFoleo && applyInv) {
        folioActual = folioNum + totalPages - 1;
      } else {
        folioActual = folioNum;
      }

      try {
        var finalPdf = await PDFLib.PDFDocument.create();
        var loadedDocs = new Map();

        for (var _i = 0, _keys = Array.from(pdfDocumentsData.keys()); _i < _keys.length; _i++) {
          var fid = _keys[_i];
          loadedDocs.set(fid, await PDFLib.PDFDocument.load(pdfDocumentsData.get(fid), {
            ignoreEncryption: true
          }));
        }

        var font = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);

        for (var i = 0; i < pageRegistry.length; i++) {
          updateProgress(i, pageRegistry.length);

          if (i % 10 === 0) await new Promise(function (r) { setTimeout(r, 1); });

          var req = pageRegistry[i];
          var srcDoc = loadedDocs.get(req.fileId);
          if (!srcDoc) continue;

          var copiedPages = await finalPdf.copyPages(srcDoc, [req.pageIndex]);
          var copiedPage = copiedPages[0];

          if (req.rotation !== 0) {
            var currentRot = copiedPage.getRotation().angle;
            copiedPage.setRotation(PDFLib.degrees(currentRot + req.rotation));
          }

          finalPdf.addPage(copiedPage);

          if (applyFoleo) {
            var fStr = String(folioActual).padStart(3, '0');
            var size = copiedPage.getSize();
            var w = size.width;
            var h = size.height;

            copiedPage.drawRectangle({
              x: w - 40, y: h - 25,
              width: 30, height: 16,
              color: PDFLib.rgb(1, 1, 1)
            });

            copiedPage.drawText(fStr, {
              x: w - 36, y: h - 21,
              size: 11, font: font,
              color: PDFLib.rgb(0, 0, 0)
            });

            // Foleo inverso: decrementa; normal: incrementa
            if (applyInv) {
              folioActual--;
            } else {
              folioActual++;
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

        setTimeout(function () {
          URL.revokeObjectURL(url);
          revokedUrls.delete(url);
        }, 3000);

        showToast('PDF unificado generado exitosamente.', 'success');
      } catch (e) {
        console.error('Error en unificación:', e);
        showToast('Error crítico durante la unificación: ' + e.message, 'error');
      } finally {
        hideLoader();
      }
    });

    /* ═══════════════════════════════════════════════
       LOADER / PROGRESS / TOAST
       ═══════════════════════════════════════════════ */
    var loaderTimeout = null;

    function showLoader(msg, withProgress) {
      if (!overlay) return;
      textStatus.textContent = msg || 'Procesando...';
      overlay.classList.remove('hidden');
      if (withProgress) {
        progressBar.classList.remove('hidden');
        progressBar.value = 0;
      } else {
        progressBar.classList.add('hidden');
      }
      // Timeout de seguridad: 90s
      if (loaderTimeout) clearTimeout(loaderTimeout);
      loaderTimeout = setTimeout(function () {
        hideLoader();
        showToast('La operación está tardando más de lo esperado. Verifica tu conexión.', 'warning');
      }, 90000);
    }

    function updateProgress(current, total) {
      if (!progressBar || progressBar.classList.contains('hidden')) return;
      progressBar.value = Math.round((current / total) * 100);
    }

    function hideLoader() {
      if (!overlay) return;
      overlay.classList.add('hidden');
      progressBar.classList.add('hidden');
      if (loaderTimeout) {
        clearTimeout(loaderTimeout);
        loaderTimeout = null;
      }
    }

    function showToast(msg, type) {
      var container = document.getElementById('toast-container');
      if (!container) return;
      var toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'error');
      toast.textContent = msg;
      toast.addEventListener('click', function () {
        toast.classList.add('toast-out');
        setTimeout(function () {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
      });
      container.appendChild(toast);
      setTimeout(function () {
        if (toast.parentNode) {
          toast.classList.add('toast-out');
          setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
          }, 300);
        }
      }, 5000);
    }

    /* ── Limpieza de memoria al salir ── */
    window.addEventListener('beforeunload', function () {
      revokedUrls.forEach(function (url) {
        URL.revokeObjectURL(url);
      });
      revokedUrls.clear();
    });

    console.log('✅ UNIFICADOR SEDAPAL v4 — inicializado con MultiDrag nativo.');
  }

})();
