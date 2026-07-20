/* ═══════════════════════════════════════════════════
   index.js — UNIFICADOR SEDAPAL (Fortificado v5)
   ✅ Multi-Drag manual de grupo
   ✅ Soporte Word/DOCX → hojas → workspace → PDF
   ✅ Foleo normal + inverso
   ✅ IIFE estricto · CDN guards · Magic bytes
   ═══════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Guard DOM ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {

    /* ── Validación CDNs ── */
    if (typeof pdfjsLib === 'undefined') {
      const banner = document.getElementById('cdn-error');
      if (banner) { banner.classList.remove('hidden'); banner.textContent = '⚠️ Motor PDF no disponible. Verifica tu conexión.'; }
      return;
    }
    if (typeof Sortable === 'undefined') {
      console.warn('⚠️ SortableJS no disponible. Solo drag nativo.');
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

    /* ── Referencias DOM ── */
    const workspace    = document.getElementById('workspace');
    const btnGenerate  = document.getElementById('btn-generate');
    const overlay      = document.getElementById('loading-overlay');
    const textStatus   = document.getElementById('loading-text');
    const progressBar  = document.getElementById('progress-bar');
    const dropZone     = document.getElementById('drop-zone');
    const fileInput    = document.getElementById('file-input');
    const chkFoleo     = document.getElementById('chk-foleo');
    const chkFoleoInv  = document.getElementById('chk-foleo-inverso');
    const folioStart   = document.getElementById('folio-start');
    const chkOptimize  = document.getElementById('chk-optimize');

    /* ── Estado interno ── */
    let pdfDocumentsData  = new Map();
    let wordDocumentsData = new Map(); // Buffers de Word → array de thumbnails por hoja
    let pageRegistry      = [];
    let multiDragGroup    = null;
    let multiDragAnchor   = null;
    let isGenerating      = false;
    const revokedUrls     = new Set();

    const generateId = () => {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    };

    /* ═══════════════════════════════════════════════
       UTILIDADES
       ═══════════════════════════════════════════════ */
    function showToast(msg, type) {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = msg;
      toast.addEventListener('click', () => {
        toast.classList.add('toast-out');
        setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
      });
      container.appendChild(toast);
      setTimeout(() => {
        if (toast.parentNode) {
          toast.classList.add('toast-out');
          setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
        }
      }, 5000);
    }

    function showLoader(msg, withProgress) {
      if (!overlay) return;
      textStatus.textContent = msg || 'Procesando...';
      overlay.classList.remove('hidden');
      progressBar.classList.toggle('hidden', !withProgress);
      if (withProgress) progressBar.value = 0;
    }

    function updateProgress(cur, total) {
      if (!progressBar || progressBar.classList.contains('hidden')) return;
      progressBar.value = Math.round((cur / total) * 100);
    }

    function hideLoader() {
      if (!overlay) return;
      overlay.classList.add('hidden');
      progressBar.classList.add('hidden');
    }

    function isValidPDF(buffer) {
      const arr = new Uint8Array(buffer.slice(0, 5));
      return arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46; // %PDF
    }

    function isValidDOCX(buffer) {
      // Verifica firma ZIP (PK)
      const arr = new Uint8Array(buffer.slice(0, 2));
      return arr[0] === 0x50 && arr[1] === 0x4B;
    }

    /* ═══════════════════════════════════════════════
       SYNC REGISTRY ↔ DOM
       ═══════════════════════════════════════════════ */
    function syncRegistryWithDOM() {
      const newOrder = [];
      Array.from(workspace.children).forEach(card => {
        const record = pageRegistry.find(p => p.id === card.dataset.id);
        if (record) newOrder.push(record);
      });
      pageRegistry = newOrder;
      btnGenerate.disabled = (pageRegistry.length === 0) || isGenerating;
    }

    /* ═══════════════════════════════════════════════
       SORTABLE — MULTI-DRAG MANUAL
       ═══════════════════════════════════════════════ */
    if (typeof Sortable !== 'undefined') {
      new Sortable(workspace, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        delay: 0,
        delayOnTouchOnly: true,
        touchStartThreshold: 3,

        onStart(evt) {
          const card = evt.item;
          const selected = document.querySelectorAll('.page-card.selected');

          // Si la tarjeta arrastrada NO está seleccionada → seleccionar solo ella
          if (!card.classList.contains('selected')) {
            document.querySelectorAll('.page-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            multiDragGroup = null;
            multiDragAnchor = null;
            return;
          }

          // Si solo hay 1 seleccionada → arrastre normal
          if (selected.length <= 1) {
            multiDragGroup = null;
            multiDragAnchor = null;
            return;
          }

          // ── MULTI-DRAG: ocultar las demás seleccionadas ──
          multiDragGroup = [];
          multiDragAnchor = card.dataset.id;

          selected.forEach(c => {
            if (c !== card) {
              multiDragGroup.push({ element: c, id: c.dataset.id });
              c.style.display = 'none';
            }
          });

          // Badge visual «+N»
          let badge = card.querySelector('.multi-drag-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'multi-drag-badge';
            card.appendChild(badge);
          }
          badge.textContent = '+' + multiDragGroup.length;
        },

        onEnd() {
          if (!multiDragGroup || multiDragGroup.length === 0) {
            const badge = document.querySelector('.multi-drag-badge');
            if (badge) badge.remove();
            syncRegistryWithDOM();
            return;
          }

          // Reinsertar tarjetas ocultas justo después del ancla
          const anchorCard = document.querySelector('[data-id="' + multiDragAnchor + '"]');
          if (anchorCard) {
            multiDragGroup.forEach(item => {
              item.element.style.display = '';
              anchorCard.parentNode.insertBefore(item.element, anchorCard.nextSibling);
            });
          } else {
            multiDragGroup.forEach(item => {
              item.element.style.display = '';
              workspace.appendChild(item.element);
            });
          }

          const badge = document.querySelector('.multi-drag-badge');
          if (badge) badge.remove();

          multiDragGroup = null;
          multiDragAnchor = null;
          syncRegistryWithDOM();
        }
      });
    }

    /* ═══════════════════════════════════════════════
       CREAR TARJETA EN DOM
       ═══════════════════════════════════════════════ */
    function createCardInDOM(data) {
      const card = document.createElement('div');
      card.className = 'page-card';
      if (data.isWord) card.classList.add('word-page');
      card.dataset.id = data.id;
      card.dataset.fileId = data.fileId;
      card.dataset.pageIndex = data.pageIndex;
      card.setAttribute('tabindex', '0');

      // Clic para seleccionar (Ctrl+A, Shift+Click, etc. lo maneja Sortable nativo)
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-delete-page')) return;
        if (e.ctrlKey || e.metaKey) {
          card.classList.toggle('selected');
        } else if (e.shiftKey) {
          // Selección por rango simplificada
          const cards = Array.from(workspace.querySelectorAll('.page-card'));
          const lastSelected = workspace.querySelector('.page-card.selected:last-of-type');
          if (lastSelected) {
            const idxA = cards.indexOf(lastSelected);
            const idxB = cards.indexOf(card);
            const [from, to] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
            cards.forEach((c, i) => {
              if (i >= from && i <= to) c.classList.add('selected');
            });
          } else {
            card.classList.toggle('selected');
          }
        } else {
          // Clic simple: si ya está seleccionada y hay otras, no deseleccionar (para permitir arrastre)
          if (!card.classList.contains('selected')) {
            document.querySelectorAll('.page-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
          }
        }
      });

      // Botón eliminar
      const btnDel = document.createElement('button');
      btnDel.className = 'btn-delete-page';
      btnDel.innerHTML = '✖';
      btnDel.setAttribute('aria-label', 'Eliminar página');
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        const selected = document.querySelectorAll('.page-card.selected');
        if (selected.length > 0 && card.classList.contains('selected')) {
          selected.forEach(c => c.remove());
        } else {
          card.remove();
        }
        syncRegistryWithDOM();
        // Si workspace queda vacío, limpiar buffers
        if (workspace.children.length === 0) {
          pdfDocumentsData.clear();
          wordDocumentsData.clear();
          revokedUrls.forEach(url => URL.revokeObjectURL(url));
          revokedUrls.clear();
          pageRegistry = [];
        }
      });

      // Imagen miniatura
      const img = document.createElement('img');
      img.className = 'page-image';
      img.src = data.thumb;
      img.dataset.rotation = '0';
      img.setAttribute('alt', data.isWord ? 'Hoja Word ' + (data.pageIndex + 1) : 'Página PDF ' + (data.pageIndex + 1));

      // Badge Word si aplica
      if (data.isWord) {
        const wordBadge = document.createElement('span');
        wordBadge.className = 'word-badge';
        wordBadge.textContent = 'W';
        card.appendChild(wordBadge);
      }

      // Rotación con doble clic
      card.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const currentRot = (parseInt(img.dataset.rotation) + 90) % 360;
        img.dataset.rotation = currentRot;
        img.style.transform = 'rotate(' + currentRot + 'deg)';
        const regIndex = pageRegistry.findIndex(p => p.id === data.id);
        if (regIndex > -1) pageRegistry[regIndex].rotation = currentRot;
      });

      card.appendChild(btnDel);
      card.appendChild(img);
      workspace.appendChild(card);
    }

    function createFailedCard(fileId, pageIdx, reason) {
      const id = fileId + '_failed_' + pageIdx;
      const card = document.createElement('div');
      card.className = 'page-card page-failed';
      card.dataset.id = id;
      card.dataset.fileId = fileId;
      card.dataset.pageIndex = pageIdx;

      const icon = document.createElement('div');
      icon.className = 'failed-icon';
      icon.textContent = '⚠️';

      const text = document.createElement('div');
      text.className = 'failed-text';
      text.textContent = reason || 'Error';

      card.appendChild(icon);
      card.appendChild(text);
      workspace.appendChild(card);

      pageRegistry.push({
        id,
        fileId,
        pageIndex: pageIdx,
        rotation: 0,
        thumb: null,
        isFailed: true
      });
    }

    /* ═══════════════════════════════════════════════
       PROCESAR PDF
       ═══════════════════════════════════════════════ */
    async function processPDF(file, fileId, buffer) {
      if (!isValidPDF(buffer)) {
        showToast('El archivo "' + file.name + '" no es un PDF válido.', 'error');
        return;
      }

      let loadingTask;
      try {
        loadingTask = pdfjsLib.getDocument({ data: buffer });
        const pdf = await loadingTask.promise;
        const totalPages = pdf.numPages;

        for (let i = 1; i <= totalPages; i++) {
          updateProgress(i, totalPages);
          if (i % 5 === 0) await new Promise(r => setTimeout(r, 1));

          const pageId = fileId + '_' + i;
          try {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 0.15 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

            const nodeData = {
              id: pageId,
              fileId,
              pageIndex: i - 1,
              rotation: 0,
              thumb: canvas.toDataURL('image/jpeg', 0.5),
              isWord: false
            };
            pageRegistry.push(nodeData);
            createCardInDOM(nodeData);
            canvas.width = 0;
          } catch (pageErr) {
            console.error('Error página ' + i + ':', pageErr);
            createFailedCard(fileId, i - 1, 'Pág ' + i);
          }
        }
        await pdf.destroy();
      } catch (err) {
        console.error('Error PDF:', err);
        showToast('Error al leer: ' + file.name, 'error');
      } finally {
        if (loadingTask) {
          try { loadingTask.destroy(); } catch (e) { /* silencioso */ }
        }
      }
    }

    /* ═══════════════════════════════════════════════
       PROCESAR WORD (DOCX) → renderizar como imagen
       ═══════════════════════════════════════════════ */
    async function processWord(file, fileId, buffer) {
      if (!isValidDOCX(buffer)) {
        showToast('El archivo "' + file.name + '" no es un DOCX válido.', 'error');
        return;
      }
      if (typeof mammoth === 'undefined') {
        showToast('Librería mammoth.js no disponible. No se puede procesar Word.', 'error');
        return;
      }

      try {
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
        const html = result.value;
        if (!html || html.trim().length === 0) {
          showToast('El documento "' + file.name + '" está vacío.', 'warning');
          return;
        }

        // Crear un iframe temporal para renderizar el HTML y capturar páginas A4
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:794px;height:1123px;';
        iframe.sandbox = 'allow-same-origin';
        document.body.appendChild(iframe);

        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
          'body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.6;padding:50px 56px;width:794px;box-sizing:border-box;color:#333;}' +
          'table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ccc;padding:6px;}' +
          'img{max-width:100%;height:auto;}' +
          '@page{size:A4;margin:0;}' +
          '.page-break{page-break-after:always;}' +
          '</style></head><body>' + html + '</body></html>');
        iframeDoc.close();

        // Esperar renderizado
        await new Promise(r => setTimeout(r, 500));

        const body = iframeDoc.body;
        const totalHeight = body.scrollHeight;
        const pageHeight = 1123; // px equivalentes a A4

        // Detectar saltos de página explícitos
        const pageBreaks = body.querySelectorAll('.page-break, [style*="page-break-after"], hr[style*="page-break"]');

        let pages = [];
        if (pageBreaks.length > 0) {
          // Dividir por saltos de página explícitos
          let currentPageContent = [];
          const allNodes = Array.from(body.childNodes);
          for (const node of allNodes) {
            const isBreak = (node.nodeType === 1 && (
              node.classList.contains('page-break') ||
              (node.style && node.style.pageBreakAfter === 'always')
            ));
            if (isBreak) {
              if (currentPageContent.length > 0) pages.push(currentPageContent);
              currentPageContent = [];
            } else if (node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim())) {
              currentPageContent.push(node);
            }
          }
          if (currentPageContent.length > 0) pages.push(currentPageContent);
        } else {
          // Dividir por altura (aproximación A4)
          const totalPagesEst = Math.max(1, Math.ceil(totalHeight / pageHeight));
          for (let p = 0; p < totalPagesEst; p++) {
            pages.push([p]);
          }
        }

        // Renderizar cada página como imagen via html2canvas o canvas manual
        const offscreenCanvas = document.getElementById('offscreen-canvas');
        if (offscreenCanvas && typeof html2canvas !== 'undefined') {
          // Crear un div temporal con el contenido de cada página
          for (let p = 0; p < pages.length; p++) {
            updateProgress(p + 1, pages.length);

            const tempDiv = document.createElement('div');
            tempDiv.style.cssText = 'width:794px;padding:50px 56px;box-sizing:border-box;background:#fff;font-family:Arial,sans-serif;font-size:12pt;line-height:1.6;color:#333;';
            if (Array.isArray(pages[p])) {
              pages[p].forEach(node => tempDiv.appendChild(node.cloneNode(true)));
            }
            document.body.appendChild(tempDiv);

            try {
              const canvas = await html2canvas(tempDiv, { scale: 0.3, useCORS: true, logging: false, width: 794 });
              const pageId = fileId + '_w_' + (p + 1);
              const nodeData = {
                id: pageId,
                fileId,
                pageIndex: p,
                rotation: 0,
                thumb: canvas.toDataURL('image/jpeg', 0.5),
                isWord: true
              };
              pageRegistry.push(nodeData);
              createCardInDOM(nodeData);
              canvas.width = 0;
            } catch (e) {
              createFailedCard(fileId, p, 'Word pág ' + (p + 1));
            }
            document.body.removeChild(tempDiv);
          }
        } else {
          // Fallback: crear tarjetas placeholder sin thumbnail
          for (let p = 0; p < pages.length; p++) {
            const pageId = fileId + '_w_' + (p + 1);
            const nodeData = {
              id: pageId,
              fileId,
              pageIndex: p,
              rotation: 0,
              thumb: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="130" height="185"><rect width="130" height="185" fill="#f0f4f8"/><text x="65" y="80" text-anchor="middle" font-size="14" fill="#00529b" font-family="Arial">WORD</text><text x="65" y="105" text-anchor="middle" font-size="11" fill="#666" font-family="Arial">Hoja ' + (p + 1) + '</text></svg>'),
              isWord: true
            };
            pageRegistry.push(nodeData);
            createCardInDOM(nodeData);
          }
        }

        document.body.removeChild(iframe);
      } catch (err) {
        console.error('Error Word:', err);
        showToast('Error al procesar: ' + file.name, 'error');
      }
    }

    /* ═══════════════════════════════════════════════
       PROCESAR ARCHIVOS (PDF + DOCX)
       ═══════════════════════════════════════════════ */
    async function processFiles(files) {
      const allFiles = Array.from(files);
      const pdfs  = allFiles.filter(f => f.type === 'application/pdf'  || f.name.toLowerCase().endsWith('.pdf'));
      const docxs = allFiles.filter(f => f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || f.name.toLowerCase().endsWith('.docx'));

      if (pdfs.length === 0 && docxs.length === 0) {
        showToast('Solo se aceptan PDF y DOCX.', 'warning');
        return;
      }

      showLoader('Procesando archivos...', true);
      btnGenerate.disabled = true;
      const totalFiles = pdfs.length + docxs.length;
      let processed = 0;

      // Procesar PDFs
      for (const file of pdfs) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        pdfDocumentsData.set(fileId, { buffer, name: file.name });
        await processPDF(file, fileId, buffer);
        processed++;
        updateProgress(processed, totalFiles);
      }

      // Procesar DOCXs
      for (const file of docxs) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        wordDocumentsData.set(fileId, { buffer, name: file.name });
        await processWord(file, fileId, buffer);
        processed++;
        updateProgress(processed, totalFiles);
      }

      btnGenerate.disabled = (pageRegistry.length === 0);
      hideLoader();
      fileInput.value = '';

      if (pageRegistry.length > 0) {
        showToast('Cargadas ' + pageRegistry.length + ' páginas. Organízalas y genera el PDF.', 'success');
      }
    }

    /* ═══════════════════════════════════════════════
       GENERAR PDF UNIFICADO
       ═══════════════════════════════════════════════ */
    btnGenerate.addEventListener('click', async () => {
      if (pageRegistry.length === 0 || isGenerating) return;

      isGenerating = true;
      const applyFoleo   = chkFoleo && chkFoleo.checked;
      const applyFoleoInv = chkFoleoInv && chkFoleoInv.checked;
      const optimize     = chkOptimize && chkOptimize.checked;
      let folioNum       = parseInt((folioStart && folioStart.value) || 1) || 1;

      showLoader('Compilando documento final...', true);

      try {
        const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
        const finalPdf   = await PDFDocument.create();
        const loadedDocs = new Map();

        // Cargar PDFs
        for (const [fileId, entry] of pdfDocumentsData.entries()) {
          try {
            loadedDocs.set(fileId, await PDFDocument.load(entry.buffer, { ignoreEncryption: true }));
          } catch (e) {
            console.error('Error al cargar ' + entry.name, e);
          }
        }

        // Para páginas Word: crear un PDF temporal con la imagen insertada
        for (const [fileId, entry] of wordDocumentsData.entries()) {
          try {
            loadedDocs.set(fileId, { isWord: true, name: entry.name });
          } catch (e) {
            console.error('Error Word buffer ' + entry.name, e);
          }
        }

        const font = await finalPdf.embedFont(StandardFonts.HelveticaBold);

        // Si foleo inverso, calcular valor inicial (última página = número más bajo)
        if (applyFoleo && applyFoleoInv) {
          folioNum = folioNum + pageRegistry.length - 1;
        }

        for (let i = 0; i < pageRegistry.length; i++) {
          updateProgress(i, pageRegistry.length);
          if (i % 10 === 0) await new Promise(r => setTimeout(r, 1));

          const req = pageRegistry[i];
          if (req.isFailed) continue; // Saltar páginas fallidas

          const src = loadedDocs.get(req.fileId);
          if (!src) continue;

          if (src.isWord) {
            // Páginas Word: insertar como imagen en página A4
            if (req.thumb && !req.thumb.startsWith('data:image/svg')) {
              const page = finalPdf.addPage([595.28, 841.89]); // A4 portrait
              try {
                const imgBytes = await fetch(req.thumb).then(r => r.arrayBuffer());
                let image;
                if (req.thumb.startsWith('data:image/jpeg') || req.thumb.startsWith('data:image/jpg')) {
                  image = await finalPdf.embedJpg(imgBytes);
                } else {
                  image = await finalPdf.embedPng(imgBytes);
                }
                const dims = image.scaleToFit(515, 740);
                page.drawImage(image, {
                  x: (595.28 - dims.width) / 2,
                  y: (841.89 - dims.height) / 2,
                  width: dims.width,
                  height: dims.height
                });
              } catch (e) {
                console.error('Error al insertar imagen Word:', e);
              }
            } else {
              finalPdf.addPage([595.28, 841.89]);
            }
          } else {
            // Páginas PDF normales
            try {
              const [copiedPage] = await finalPdf.copyPages(src, [req.pageIndex]);
              if (req.rotation !== 0) {
                const currentRot = copiedPage.getRotation().angle;
                copiedPage.setRotation(degrees(currentRot + req.rotation));
              }
              finalPdf.addPage(copiedPage);
            } catch (e) {
              finalPdf.addPage([595.28, 841.89]);
            }
          }

          // Foleo
          if (applyFoleo) {
            const lastPage = finalPdf.getPage(finalPdf.getPageCount() - 1);
            const { width, height } = lastPage.getSize();
            const fStr = String(applyFoleoInv ? folioNum : folioNum).padStart(3, '0');

            lastPage.drawRectangle({
              x: width - 40, y: height - 25,
              width: 30, height: 16,
              color: rgb(1, 1, 1)
            });
            lastPage.drawText(fStr, {
              x: width - 36, y: height - 21,
              size: 11, font,
              color: rgb(0, 0, 0)
            });

            if (applyFoleoInv) {
              folioNum--;
            } else {
              folioNum++;
            }
          }
        }

        const saveOptions = optimize ? { useObjectStreams: true } : {};
        const finalBytes = await finalPdf.save(saveOptions);

        const blob = new Blob([finalBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        revokedUrls.add(url);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'SEDAPAL_Unificado_' + new Date().toISOString().split('T')[0] + '.pdf';
        link.click();

        setTimeout(() => {
          URL.revokeObjectURL(url);
          revokedUrls.delete(url);
        }, 3000);

        showToast('✅ PDF unificado generado exitosamente.', 'success');
      } catch (e) {
        console.error('Error en unificación:', e);
        showToast('Error crítico: ' + e.message, 'error');
      } finally {
        isGenerating = false;
        btnGenerate.disabled = (pageRegistry.length === 0);
        hideLoader();
      }
    });

    /* ═══════════════════════════════════════════════
       EVENTOS DROP ZONE / FILE INPUT
       ═══════════════════════════════════════════════ */
    dropZone.addEventListener('click', () => fileInput.click());

    ['dragover', 'dragenter'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    }));

    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    }));

    dropZone.addEventListener('drop', ev => processFiles(ev.dataTransfer.files));
    fileInput.addEventListener('change', ev => processFiles(ev.target.files));

    /* ═══════════════════════════════════════════════
       TECLAS: Supr / Ctrl+A / Escape
       ═══════════════════════════════════════════════ */
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selected = document.querySelectorAll('.page-card.selected');
        if (selected.length > 0) {
          selected.forEach(c => c.remove());
          syncRegistryWithDOM();
          if (workspace.children.length === 0) {
            pdfDocumentsData.clear();
            wordDocumentsData.clear();
          }
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        document.querySelectorAll('.page-card').forEach(c => c.classList.add('selected'));
      }

      if (e.key === 'Escape') {
        document.querySelectorAll('.page-card.selected').forEach(c => c.classList.remove('selected'));
      }
    });

    /* ═══════════════════════════════════════════════
       FOLEO INVERSO: mostrar/ocultar
       ═══════════════════════════════════════════════ */
    if (chkFoleo && chkFoleoInv) {
      const invRow = document.getElementById('row-foleo-inverso');
      chkFoleo.addEventListener('change', () => {
        if (invRow) invRow.style.display = chkFoleo.checked ? '' : 'none';
        if (!chkFoleo.checked) chkFoleoInv.checked = false;
      });
      // Estado inicial
      if (invRow) invRow.style.display = chkFoleo.checked ? '' : 'none';
    }

    /* ═══════════════════════════════════════════════
       LIMPIEZA AL CERRAR
       ═══════════════════════════════════════════════ */
    window.addEventListener('beforeunload', () => {
      revokedUrls.forEach(url => URL.revokeObjectURL(url));
      revokedUrls.clear();
    });

    console.log('✅ UNIFICADOR SEDAPAL — inicializado. PDF + DOCX + Multi-Drag.');
  }
})();
