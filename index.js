/* ============================================================
   UNIFICADOR SEDAPAL — Lógica fortificada
   ============================================================ */
(function () {
    'use strict';

    /* ---------- GUARDAS DE ENTORNO ---------- */
    if (typeof PDFLib === 'undefined') {
        showToast('Librería pdf-lib no disponible. La unificación no funcionará.', 'error');
    }
    if (typeof pdfjsLib === 'undefined') {
        showToast('Motor PDF.js no disponible. No se generarán miniaturas.', 'error');
    }

    /* ---------- CONFIGURACIÓN DE PDF.JS ---------- */
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    }

    /* ---------- REFERENCIAS AL DOM ---------- */
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const workspace   = $('#workspace');
    const btnGenerate = $('#btn-generate');
    const overlay     = $('#loading-overlay');
    const textStatus  = $('#loading-text');
    const progressBar = $('#progress-bar');
    const dropZone    = $('#drop-zone');
    const fileInput   = $('#file-input');
    const chkFoleo    = $('#chk-foleo');
    const folioStart  = $('#folio-start');
    const chkOptimize = $('#chk-optimize');

    /* ---------- ESTADO ---------- */
    const pdfDocumentsData = new Map();   // fileId → ArrayBuffer
    let pageRegistry = [];                // [{ id, fileId, pageIndex, rotation, thumb }]
    const revokedUrls = new Set();        // tracking de URL.createObjectURL

    /* ---------- UTILIDADES ---------- */
    const generateId = () => {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback determinista
        return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 11);
    };

    /** Muestra un toast de notificación */
    function showToast(msg, type) {
        const container = $('#toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast' + (type ? ' ' + type : '');
        toast.textContent = msg;
        container.appendChild(toast);
        // Auto-eliminar tras la animación
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4200);
    }

    /** Activa / desactiva el overlay de carga */
    function showLoader(msg, withProgress) {
        textStatus.textContent = msg;
        overlay.classList.remove('hidden');
        progressBar.classList.toggle('hidden', !withProgress);
        if (withProgress) progressBar.value = 0;
    }

    function updateProgress(current, total) {
        if (total === 0) { progressBar.value = 0; return; }
        progressBar.value = Math.min(100, Math.round((current / total) * 100));
    }

    function hideLoader() {
        overlay.classList.add('hidden');
        progressBar.classList.add('hidden');
    }

    /** Timeout de seguridad: si el loader lleva >90s visible, lo oculta */
    let loaderTimeout = null;
    function startLoaderTimeout() {
        clearTimeout(loaderTimeout);
        loaderTimeout = setTimeout(() => {
            hideLoader();
            showToast('La operación está tardando más de lo esperado. Intenta con menos páginas.', 'warn');
        }, 90_000);
    }
    function clearLoaderTimeout() {
        clearTimeout(loaderTimeout);
        loaderTimeout = null;
    }

    /** Revoca todas las URLs de objeto acumuladas */
    function revokeAllUrls() {
        revokedUrls.forEach(url => {
            try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
        });
        revokedUrls.clear();
    }

    /* ---------- VALIDACIÓN DE PDF ---------- */
    /**
     * Verifica los magic bytes %PDF en los primeros 5 bytes del buffer.
     * Retorna true si es un PDF válido.
     */
    function isValidPDF(buffer) {
        if (!buffer || buffer.byteLength < 5) return false;
        const header = new Uint8Array(buffer.slice(0, 5));
        const magic = String.fromCharCode.apply(null, header);
        return magic.startsWith('%PDF');
    }

    /* ---------- SINCRONIZACIÓN REGISTRO ↔ DOM ---------- */
    function syncRegistryWithDOM() {
        const newOrder = [];
        Array.from(workspace.children).forEach(card => {
            const record = pageRegistry.find(p => p.id === card.dataset.id);
            if (record) newOrder.push(record);
        });
        pageRegistry = newOrder;
        btnGenerate.disabled = pageRegistry.length === 0;
        btnGenerate.setAttribute('aria-disabled', btnGenerate.disabled);

        // Si el workspace queda vacío, liberamos los buffers
        if (pageRegistry.length === 0) {
            pdfDocumentsData.clear();
        }
    }

    /* ---------- CREACIÓN DE TARJETA EN EL DOM ---------- */
    function createCardInDOM(data) {
        const card = document.createElement('div');
        card.className = 'page-card';
        card.dataset.id = data.id;
        card.tabIndex = 0;
        card.setAttribute('role', 'listitem');
        card.setAttribute('aria-label', 'Página ' + (data.pageIndex + 1));

        // --- Selección múltiple con clic simple ---
        card.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete-page')) return;
            card.classList.toggle('selected');
        });

        // --- Botón de eliminar ---
        const btnDel = document.createElement('button');
        btnDel.className = 'btn-delete-page';
        btnDel.innerHTML = '✖';
        btnDel.setAttribute('aria-label', 'Eliminar página');
        btnDel.onclick = (e) => {
            e.stopPropagation();
            const selected = $$('.page-card.selected');
            if (selected.length > 0 && card.classList.contains('selected')) {
                selected.forEach(c => c.remove());
            } else {
                card.remove();
            }
            syncRegistryWithDOM();
        };
        card.appendChild(btnDel);

        // --- Imagen miniatura ---
        const img = document.createElement('img');
        img.className = 'page-image';
        img.src = data.thumb;
        img.dataset.rotation = '0';
        img.alt = 'Miniatura de página ' + (data.pageIndex + 1);
        img.loading = 'lazy';
        card.appendChild(img);

        // --- Rotación con doble clic ---
        card.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const currentRot = (parseInt(img.dataset.rotation, 10) + 90) % 360;
            img.dataset.rotation = currentRot;
            img.style.transform = 'rotate(' + currentRot + 'deg)';

            const regIndex = pageRegistry.findIndex(p => p.id === data.id);
            if (regIndex > -1) pageRegistry[regIndex].rotation = currentRot;
        });

        workspace.appendChild(card);
    }

    /**
     * Crea una tarjeta placeholder para páginas que fallaron al renderizar.
     */
    function createFailedCard(fileId, pageNum) {
        const pageId = fileId + '_failed_' + pageNum;
        const card = document.createElement('div');
        card.className = 'page-card page-failed';
        card.dataset.id = pageId;
        card.tabIndex = 0;
        card.setAttribute('aria-label', 'Página ' + pageNum + ' — no se pudo renderizar');

        const btnDel = document.createElement('button');
        btnDel.className = 'btn-delete-page';
        btnDel.innerHTML = '✖';
        btnDel.setAttribute('aria-label', 'Eliminar página fallida');
        btnDel.onclick = (e) => {
            e.stopPropagation();
            card.remove();
            syncRegistryWithDOM();
        };
        card.appendChild(btnDel);

        const label = document.createElement('div');
        label.className = 'page-failed-label';
        label.innerHTML = '<span>⚠️</span><span>Pág. ' + pageNum + '</span><span>Error</span>';
        card.appendChild(label);

        // También permite seleccionar tarjetas fallidas
        card.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete-page')) return;
            card.classList.toggle('selected');
        });

        workspace.appendChild(card);

        // Registramos un placeholder en el registry para mantener coherencia
        const nodeData = {
            id: pageId,
            fileId: fileId,
            pageIndex: -1,        // marcador: página inválida
            rotation: 0,
            thumb: null
        };
        pageRegistry.push(nodeData);
    }

    /* ---------- PROCESAMIENTO DE ARCHIVOS ---------- */
    async function processFiles(files) {
        // Filtro fortificado: MIME type + extensión
        const pdfs = Array.from(files).filter(f =>
            f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
        );

        if (pdfs.length === 0) {
            showToast('Por favor, sube únicamente archivos en formato PDF.', 'warn');
            return;
        }

        showLoader('Procesando páginas...', true);
        startLoaderTimeout();
        btnGenerate.disabled = true;
        btnGenerate.setAttribute('aria-disabled', 'true');

        let totalPagesProcessed = 0;
        let totalPagesFailed = 0;

        for (const file of pdfs) {
            const fileId = generateId();
            let buffer;
            try {
                buffer = await file.arrayBuffer();
            } catch (err) {
                console.error('Error al leer el archivo ' + file.name + ': ', err);
                showToast('No se pudo leer: ' + file.name, 'error');
                continue;
            }

            // Validación de magic bytes
            if (!isValidPDF(buffer)) {
                showToast('El archivo "' + file.name + '" no es un PDF válido. Se omitió.', 'warn');
                continue;
            }

            pdfDocumentsData.set(fileId, buffer);

            // --- Renderizado con pdf.js ---
            if (typeof pdfjsLib === 'undefined') {
                showToast('PDF.js no disponible. No se generarán miniaturas para: ' + file.name, 'warn');
                continue;
            }

            let loadingTask = null;
            let pdf = null;
            try {
                loadingTask = pdfjsLib.getDocument({ data: buffer.slice(0) });
                pdf = await loadingTask.promise;
            } catch (err) {
                console.error('Error al abrir PDF ' + file.name + ': ', err);
                showToast('No se pudo interpretar: ' + file.name + '. Puede estar corrupto.', 'error');
                pdfDocumentsData.delete(fileId);
                if (loadingTask) {
                    try { loadingTask.destroy(); } catch (_) { /* noop */ }
                }
                continue;
            }

            const totalPages = pdf.numPages;

            for (let i = 1; i <= totalPages; i++) {
                updateProgress(totalPagesProcessed + i, totalPagesProcessed + totalPages);

                // Micro-pausa cada 5 páginas para no congelar el hilo principal
                if (i % 5 === 0) {
                    await new Promise(r => setTimeout(r, 1));
                }

                const pageId = fileId + '_' + i;

                try {
                    const page = await pdf.getPage(i);
                    const viewport = page.getViewport({ scale: 0.15 });

                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    const ctx = canvas.getContext('2d');

                    await page.render({ canvasContext: ctx, viewport }).promise;

                    const thumb = canvas.toDataURL('image/jpeg', 0.5);

                    // Liberar canvas
                    canvas.width = 0;
                    canvas.height = 0;

                    const nodeData = {
                        id: pageId,
                        fileId: fileId,
                        pageIndex: i - 1,
                        rotation: 0,
                        thumb: thumb
                    };

                    pageRegistry.push(nodeData);
                    createCardInDOM(nodeData);
                    totalPagesProcessed++;

                } catch (pageErr) {
                    // Página individual fallida — no detiene el resto
                    console.warn('Error al renderizar página ' + i + ' de ' + file.name + ': ', pageErr);
                    createFailedCard(fileId, i);
                    totalPagesFailed++;
                }
            }

            // Liberar recursos de pdf.js
            try { pdf.destroy(); } catch (_) { /* noop */ }
            try { loadingTask.destroy(); } catch (_) { /* noop */ }
        }

        // Resumen final
        if (totalPagesFailed > 0) {
            showToast(
                totalPagesProcessed + ' páginas listas. ' + totalPagesFailed + ' páginas fallaron (marcadas en rojo).',
                'warn'
            );
        } else if (totalPagesProcessed > 0) {
            showToast(totalPagesProcessed + ' páginas procesadas correctamente.', '');
        }

        btnGenerate.disabled = pageRegistry.length === 0;
        btnGenerate.setAttribute('aria-disabled', btnGenerate.disabled);
        clearLoaderTimeout();
        hideLoader();

        // Limpiar input para permitir re-subir el mismo archivo
        fileInput.value = '';
    }

    /* ---------- UNIFICACIÓN FINAL ---------- */
    async function unifyAndDownload() {
        if (pageRegistry.length === 0) return;

        // Filtrar páginas fallidas (pageIndex === -1)
        const validPages = pageRegistry.filter(p => p.pageIndex >= 0);
        if (validPages.length === 0) {
            showToast('No hay páginas válidas para unificar.', 'error');
            return;
        }

        showLoader('Compilando documento final...', true);
        startLoaderTimeout();

        const applyFoleo = chkFoleo.checked;
        const optimize   = chkOptimize.checked;
        let folioNum     = parseInt(folioStart.value, 10) || 1;

        try {
            const finalPdf = await PDFLib.PDFDocument.create();
            const loadedDocs = new Map();

            // Cargar cada documento fuente una sola vez
            for (const [fileId, buffer] of pdfDocumentsData.entries()) {
                try {
                    const doc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
                    loadedDocs.set(fileId, doc);
                } catch (err) {
                    console.error('Error al cargar documento para unificación: ', err);
                    showToast('Error al cargar un documento fuente. Se omitirán sus páginas.', 'error');
                }
            }

            const font = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);

            for (let i = 0; i < validPages.length; i++) {
                updateProgress(i, validPages.length);

                // Chunking cada 10 páginas
                if (i % 10 === 0) {
                    await new Promise(r => setTimeout(r, 1));
                }

                const req = validPages[i];
                const srcDoc = loadedDocs.get(req.fileId);
                if (!srcDoc) continue; // documento no cargado

                const [copiedPage] = await finalPdf.copyPages(srcDoc, [req.pageIndex]);

                // Aplicar rotación si existe
                if (req.rotation !== 0) {
                    const currentRot = copiedPage.getRotation().angle;
                    copiedPage.setRotation(PDFLib.degrees(currentRot + req.rotation));
                }

                finalPdf.addPage(copiedPage);

                // Foleo
                if (applyFoleo) {
                    const fStr = folioNum.toString().padStart(3, '0');
                    const { width, height } = copiedPage.getSize();

                    copiedPage.drawRectangle({
                        x: width - 40,
                        y: height - 25,
                        width: 30,
                        height: 16,
                        color: PDFLib.rgb(1, 1, 1)
                    });

                    copiedPage.drawText(fStr, {
                        x: width - 36,
                        y: height - 21,
                        size: 11,
                        font: font,
                        color: PDFLib.rgb(0, 0, 0)
                    });
                    folioNum++;
                }
            }

            const saveOptions = optimize ? { useObjectStreams: true } : {};
            const finalBytes = await finalPdf.save(saveOptions);

            // Descarga
            const blob = new Blob([finalBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            revokedUrls.add(url);

            const link = document.createElement('a');
            link.href = url;
            link.download = 'SEDAPAL_Unificado_' + new Date().toISOString().split('T')[0] + '.pdf';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // Revocar tras un breve delay para asegurar la descarga
            setTimeout(() => {
                URL.revokeObjectURL(url);
                revokedUrls.delete(url);
            }, 3000);

            showToast('PDF unificado descargado exitosamente.', '');

        } catch (e) {
            console.error('Error crítico durante la unificación: ', e);
            showToast('Error durante la unificación: ' + e.message, 'error');
        } finally {
            clearLoaderTimeout();
            hideLoader();
        }
    }

    /* ---------- INICIALIZACIÓN DE SORTABLE ---------- */
    function initSortable() {
        if (typeof Sortable === 'undefined') {
            console.warn('SortableJS no disponible. El reordenamiento por arrastre no funcionará.');
            return;
        }
        try {
            new Sortable(workspace, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                delay: 100,
                delayOnTouchOnly: true,
                onEnd: () => syncRegistryWithDOM()
            });
        } catch (err) {
            console.warn('No se pudo inicializar Sortable: ', err);
        }
    }

    /* ---------- EVENTOS ---------- */

    // Drop zone
    dropZone.addEventListener('click', () => fileInput.click());

    ['dragover', 'dragenter'].forEach(evName => {
        dropZone.addEventListener(evName, (ev) => {
            ev.preventDefault();
            dropZone.classList.add('drag-over');
        });
    });

    ['dragleave', 'drop'].forEach(evName => {
        dropZone.addEventListener(evName, (ev) => {
            ev.preventDefault();
            dropZone.classList.remove('drag-over');
        });
    });

    dropZone.addEventListener('drop', (ev) => {
        if (ev.dataTransfer.files.length > 0) {
            processFiles(ev.dataTransfer.files);
        }
    });

    fileInput.addEventListener('change', (ev) => {
        if (ev.target.files.length > 0) {
            processFiles(ev.target.files);
        }
    });

    // Botón de unificar
    btnGenerate.addEventListener('click', unifyAndDownload);

    // --- Atajos de teclado ---
    document.addEventListener('keydown', (e) => {
        // No interceptar si el foco está en un input/textarea/select
        const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        const isEditable = tag === 'input' || tag === 'textarea' || tag === 'select' ||
                           (document.activeElement && document.activeElement.isContentEditable);

        // Suprimir / Backspace → borrar seleccionadas (solo si no estamos en un campo editable)
        if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditable) {
            const selected = $$('.page-card.selected');
            if (selected.length > 0) {
                e.preventDefault();
                selected.forEach(card => card.remove());
                syncRegistryWithDOM();
            }
        }

        // Ctrl+A / Cmd+A → seleccionar todas las tarjetas
        if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !isEditable) {
            e.preventDefault();
            $$('.page-card').forEach(card => card.classList.add('selected'));
        }

        // Escape → deseleccionar todas
        if (e.key === 'Escape' && !isEditable) {
            $$('.page-card.selected').forEach(card => card.classList.remove('selected'));
        }
    });

    // --- Limpieza al cerrar la página ---
    window.addEventListener('beforeunload', () => {
        revokeAllUrls();
    });

    // --- Footer: año dinámico ---
    const yearSpan = $('#current-year');
    if (yearSpan) {
        yearSpan.textContent = new Date().getFullYear();
    }

    /* ---------- ARRANQUE ---------- */
    function boot() {
        initSortable();
        btnGenerate.disabled = true;
        btnGenerate.setAttribute('aria-disabled', 'true');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
