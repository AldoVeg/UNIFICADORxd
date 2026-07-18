/* ============================================================
   UNIFICADOR SEDAPAL — Lógica Robusta (index.js)
   ============================================================ */

(function () {
    'use strict';

    /* ==========================================================
       MÓDULO: Utilidades
       ========================================================== */

    /** Genera un ID único con crypto (fallback determinista) */
    function generateId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        // Fallback robusto: timestamp + aleatorio + contador
        const t = Date.now().toString(36);
        const r = Math.random().toString(36).substring(2, 11);
        const c = (generateId._counter = (generateId._counter || 0) + 1).toString(36);
        return `${t}-${r}-${c}`;
    }

    /** Muestra un toast de notificación */
    function showToast(message, type) {
        type = type || 'info';
        var container = document.getElementById('toast-container');
        if (!container) return;

        var toast = document.createElement('div');
        toast.className = 'toast toast--' + type;
        toast.textContent = message;
        container.appendChild(toast);

        // Auto-eliminar tras la animación
        setTimeout(function () {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 3100);
    }

    /** Valida que un ArrayBuffer corresponda a un PDF real (magic bytes %PDF) */
    function isValidPDFBuffer(buffer) {
        if (!buffer || buffer.byteLength < 5) return false;
        var arr = new Uint8Array(buffer);
        // Los primeros 5 bytes deben ser: 0x25 0x50 0x44 0x46 0x2D  => "%PDF-"
        return arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46 && arr[4] === 0x2D;
    }

    /* ==========================================================
       MÓDULO: Referencias al DOM (cache al iniciar)
       ========================================================== */

    var dom = {};

    function cacheDOM() {
        dom.workspace    = document.getElementById('workspace');
        dom.btnGenerate  = document.getElementById('btn-generate');
        dom.btnClearAll  = document.getElementById('btn-clear-all');
        dom.overlay      = document.getElementById('loading-overlay');
        dom.textStatus   = document.getElementById('loading-text');
        dom.progressBar  = document.getElementById('progress-bar');
        dom.dropZone     = document.getElementById('drop-zone');
        dom.fileInput    = document.getElementById('file-input');
        dom.chkFoleo     = document.getElementById('chk-foleo');
        dom.folioStart   = document.getElementById('folio-start');
        dom.chkOptimize  = document.getElementById('chk-optimize');
        dom.statusBar    = document.getElementById('status-bar');
        dom.statusText   = document.getElementById('status-text');
        dom.currentYear  = document.getElementById('current-year');
    }

    /* ==========================================================
       MÓDULO: Estado global
       ========================================================== */

    /** Mapa: fileId → ArrayBuffer (documentos PDF originales) */
    var pdfDocumentsData = new Map();

    /** Array ordenado de páginas (refleja el orden visual) */
    var pageRegistry = [];

    /** Set de URLs creadas con createObjectURL (para revocar al salir) */
    var blobUrls = new Set();

    /* ==========================================================
       MÓDULO: Loader / Overlay
       ========================================================== */

    function showLoader(message, withProgress) {
        dom.textStatus.textContent = message || 'Procesando...';
        dom.overlay.classList.remove('hidden');
        dom.progressBar.classList.toggle('hidden', !withProgress);
        if (withProgress) {
            dom.progressBar.value = 0;
        }
    }

    function updateProgress(current, total) {
        if (!total || total <= 0) return;
        dom.progressBar.value = Math.min((current / total) * 100, 100);
    }

    function hideLoader() {
        dom.overlay.classList.add('hidden');
        dom.progressBar.classList.add('hidden');
    }

    /* ==========================================================
       MÓDULO: Barra de estado
       ========================================================== */

    function updateStatus(message) {
        if (!message) {
            dom.statusBar.classList.add('hidden');
            return;
        }
        dom.statusBar.classList.remove('hidden');
        dom.statusText.textContent = message;
    }

    /* ==========================================================
       MÓDULO: Tarjetas en el DOM
       ========================================================== */

    /** Crea una tarjeta visual en el workspace */
    function createCardInDOM(data) {
        var card = document.createElement('div');
        card.className = 'page-card';
        card.dataset.id = data.id;
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'listitem');
        card.setAttribute('aria-label', 'Página ' + (data.pageIndex + 1));

        // --- Selección múltiple con clic simple ---
        card.addEventListener('click', function (e) {
            // Ignorar si el clic fue en el botón de eliminar
            if (e.target.classList.contains('btn-delete-page')) return;
            card.classList.toggle('selected');
        });

        // --- Botón eliminar ---
        var btnDel = document.createElement('button');
        btnDel.className = 'btn-delete-page';
        btnDel.innerHTML = '&#10006;'; // ✖ como entidad HTML
        btnDel.setAttribute('aria-label', 'Eliminar página');
        btnDel.onclick = function (e) {
            e.stopPropagation();

            var selected = dom.workspace.querySelectorAll('.page-card.selected');
            if (selected.length > 0 && card.classList.contains('selected')) {
                // Borrar todas las seleccionadas
                selected.forEach(function (c) { c.remove(); });
            } else {
                card.remove();
            }
            syncRegistryWithDOM();
        };

        // --- Imagen miniatura ---
        var img = document.createElement('img');
        img.className = 'page-image';
        img.src = data.thumb;
        img.dataset.rotation = '0';
        img.setAttribute('alt', 'Miniatura de página ' + (data.pageIndex + 1));
        img.setAttribute('draggable', 'false');

        // --- Rotación con doble clic ---
        card.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            var currentRot = (parseInt(img.dataset.rotation, 10) + 90) % 360;
            img.dataset.rotation = currentRot;
            img.style.transform = 'rotate(' + currentRot + 'deg)';

            // Sincronizar con el registro
            var regIndex = pageRegistry.findIndex(function (p) { return p.id === data.id; });
            if (regIndex > -1) {
                pageRegistry[regIndex].rotation = currentRot;
            }
        });

        card.appendChild(btnDel);
        card.appendChild(img);
        dom.workspace.appendChild(card);
    }

    /** Sincroniza pageRegistry con el orden visual del DOM */
    function syncRegistryWithDOM() {
        var newOrder = [];
        var children = dom.workspace.children;

        for (var i = 0; i < children.length; i++) {
            var cardId = children[i].dataset.id;
            var record = pageRegistry.find(function (p) { return p.id === cardId; });
            if (record) {
                newOrder.push(record);
            }
        }

        pageRegistry = newOrder;

        // Actualizar estado de botones
        var hasPages = pageRegistry.length > 0;
        dom.btnGenerate.disabled = !hasPages;
        dom.btnClearAll.disabled = !hasPages;

        // Si no quedan páginas, liberar memoria de documentos
        if (!hasPages) {
            pdfDocumentsData.clear();
        }

        updateStatus(hasPages ? pageRegistry.length + ' página(s) cargada(s)' : null);
    }

    /* ==========================================================
       MÓDULO: Procesamiento de archivos PDF
       ========================================================== */

    /**
     * Procesa una FileList, filtra PDFs, renderiza miniaturas
     * y las agrega al workspace.
     */
    async function processFiles(files) {
        if (!files || files.length === 0) return;

        // Verificar que pdfjsLib esté disponible
        if (typeof pdfjsLib === 'undefined') {
            showToast('El motor de renderizado PDF no está disponible. Recarga la página.', 'error');
            return;
        }

        // Configurar worker de pdf.js (solo la primera vez)
        if (!processFiles._workerConfigured) {
            try {
                pdfjsLib.GlobalWorkerOptions.workerSrc =
                    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                processFiles._workerConfigured = true;
            } catch (e) {
                // Continuar sin worker dedicado (más lento pero funcional)
                console.warn('No se pudo configurar el worker de PDF.js:', e.message);
            }
        }

        // Filtrar solo PDFs (por MIME y extensión)
        var pdfs = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
                pdfs.push(f);
            }
        }

        if (pdfs.length === 0) {
            showToast('Ningún archivo PDF válido encontrado. Solo se aceptan PDFs.', 'error');
            return;
        }

        showLoader('Procesando páginas...', true);
        dom.btnGenerate.disabled = true;
        dom.btnClearAll.disabled = true;

        var totalProcessed = 0;
        var totalFailed = 0;

        for (var f = 0; f < pdfs.length; f++) {
            var file = pdfs[f];
            var fileId = generateId();
            var buffer = null;

            try {
                buffer = await file.arrayBuffer();
            } catch (err) {
                console.error('Error al leer el archivo ' + file.name + ':', err);
                totalFailed++;
                continue;
            }

            // Validar magic bytes del PDF
            if (!isValidPDFBuffer(buffer)) {
                console.warn('El archivo ' + file.name + ' no parece ser un PDF válido (magic bytes incorrectos).');
                totalFailed++;
                continue;
            }

            pdfDocumentsData.set(fileId, buffer);

            try {
                var loadingTask = pdfjsLib.getDocument({ data: buffer.slice(0) });
                var pdf = await loadingTask.promise;
                var totalPages = pdf.numPages;

                for (var pageNum = 1; pageNum <= totalPages; pageNum++) {
                    updateProgress(totalProcessed + pageNum, totalPages);

                    // Micro-pausa cada 5 páginas para no saturar el event loop
                    if (pageNum % 5 === 0) {
                        await new Promise(function (r) { setTimeout(r, 1); });
                    }

                    var pageId = fileId + '_' + pageNum;

                    try {
                        var page = await pdf.getPage(pageNum);
                        var viewport = page.getViewport({ scale: 0.15 });

                        var canvas = document.createElement('canvas');
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        var ctx = canvas.getContext('2d');

                        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

                        var thumbDataUrl = canvas.toDataURL('image/jpeg', 0.5);

                        // Liberar el canvas inmediatamente
                        canvas.width = 0;
                        canvas.height = 0;
                        canvas = null;

                        var nodeData = {
                            id: pageId,
                            fileId: fileId,
                            pageIndex: pageNum - 1,
                            rotation: 0,
                            thumb: thumbDataUrl
                        };

                        pageRegistry.push(nodeData);
                        createCardInDOM(nodeData);
                        totalProcessed++;

                    } catch (pageErr) {
                        console.error('Error al renderizar página ' + pageNum + ' de ' + file.name + ':', pageErr);
                        totalFailed++;
                        // Continuar con la siguiente página
                    }

                    // Limpiar referencia a la página
                    page.cleanup && page.cleanup();
                }

                // Liberar el documento de pdf.js
                pdf.destroy && pdf.destroy();
                loadingTask.destroy && loadingTask.destroy();

            } catch (docErr) {
                console.error('Error al abrir el PDF ' + file.name + ':', docErr);
                pdfDocumentsData.delete(fileId);
                totalFailed++;
            }
        }

        // Estado final
        dom.btnGenerate.disabled = (pageRegistry.length === 0);
        dom.btnClearAll.disabled = (pageRegistry.length === 0);
        hideLoader();

        // Limpiar input para permitir re-subir el mismo archivo
        dom.fileInput.value = '';

        // Feedback
        if (totalProcessed > 0) {
            var msg = totalProcessed + ' página(s) procesada(s)';
            if (totalFailed > 0) {
                msg += ' — ' + totalFailed + ' error(es) ignorado(s)';
            }
            updateStatus(msg);
            showToast(msg, totalFailed > 0 ? 'error' : 'success');
        } else if (totalFailed > 0) {
            showToast('No se pudo procesar ningún PDF. Verifica que los archivos no estén corruptos.', 'error');
        }
    }

    /* ==========================================================
       MÓDULO: Unificación y descarga
       ========================================================== */

    async function unifyAndDownload() {
        if (pageRegistry.length === 0) return;

        // Verificar que PDFLib esté disponible
        if (typeof PDFLib === 'undefined') {
            showToast('La librería de compilación PDF no está disponible. Recarga la página.', 'error');
            return;
        }

        showLoader('Compilando documento final...', true);

        var applyFoleo  = dom.chkFoleo.checked;
        var optimize    = dom.chkOptimize.checked;
        var folioNum    = parseInt(dom.folioStart.value, 10) || 1;

        try {
            var finalPdf = await PDFLib.PDFDocument.create();
            var loadedDocs = new Map();

            // Cargar cada documento fuente una sola vez
            var fileIds = pdfDocumentsData.keys();
            for (var it = fileIds.next(); !it.done; it = fileIds.next()) {
                var fid = it.value;
                var buf = pdfDocumentsData.get(fid);
                try {
                    var doc = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
                    loadedDocs.set(fid, doc);
                } catch (loadErr) {
                    console.error('Error al cargar documento para unificación (ID ' + fid + '):', loadErr);
                    // Continuar con los demás
                }
            }

            var font = null;
            if (applyFoleo) {
                try {
                    font = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
                } catch (fontErr) {
                    console.warn('No se pudo embeber HelveticaBold, usando Helvetica:', fontErr);
                    font = await finalPdf.embedFont(PDFLib.StandardFonts.Helvetica);
                }
            }

            for (var i = 0; i < pageRegistry.length; i++) {
                updateProgress(i, pageRegistry.length);

                // Chunking: liberar el event loop cada 10 páginas
                if (i % 10 === 0) {
                    await new Promise(function (r) { setTimeout(r, 1); });
                }

                var req = pageRegistry[i];
                var srcDoc = loadedDocs.get(req.fileId);

                if (!srcDoc) {
                    console.warn('Documento fuente no encontrado para página ' + req.id + '. Se omite.');
                    continue;
                }

                var copiedPages;
                try {
                    copiedPages = await finalPdf.copyPages(srcDoc, [req.pageIndex]);
                } catch (copyErr) {
                    console.error('Error al copiar página ' + req.id + ':', copyErr);
                    continue;
                }

                var copiedPage = copiedPages[0];

                // Aplicar rotación si existe
                if (req.rotation !== 0) {
                    var currentRot = copiedPage.getRotation().angle;
                    copiedPage.setRotation(PDFLib.degrees(currentRot + req.rotation));
                }

                finalPdf.addPage(copiedPage);

                // Foleo
                if (applyFoleo && font) {
                    var fStr = String(folioNum).padStart(3, '0');
                    var size = copiedPage.getSize();
                    var w = size.width;
                    var h = size.height;

                    // Fondo blanco para el número
                    copiedPage.drawRectangle({
                        x: w - 40,
                        y: h - 25,
                        width: 30,
                        height: 16,
                        color: PDFLib.rgb(1, 1, 1)
                    });

                    copiedPage.drawText(fStr, {
                        x: w - 36,
                        y: h - 21,
                        size: 11,
                        font: font,
                        color: PDFLib.rgb(0, 0, 0)
                    });

                    folioNum++;
                }
            }

            var saveOptions = optimize ? { useObjectStreams: true } : {};
            var finalBytes;

            try {
                finalBytes = await finalPdf.save(saveOptions);
            } catch (saveErr) {
                throw new Error('Error al guardar el PDF final: ' + saveErr.message);
            }

            // Crear blob y descargar
            var blob = new Blob([finalBytes], { type: 'application/pdf' });
            var url = URL.createObjectURL(blob);
            blobUrls.add(url);

            var link = document.createElement('a');
            link.href = url;
            link.download = 'SEDAPAL_Unificado_' + new Date().toISOString().split('T')[0] + '.pdf';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // Revocar después de un tiempo prudencial
            setTimeout(function () {
                URL.revokeObjectURL(url);
                blobUrls.delete(url);
            }, 3000);

            showToast('¡Documento unificado descargado con éxito!', 'success');

        } catch (e) {
            console.error('Error crítico durante la unificación:', e);
            showToast('Error durante la unificación: ' + e.message, 'error');
        } finally {
            hideLoader();
        }
    }

    /* ==========================================================
       MÓDULO: Limpieza total del workspace
       ========================================================== */

    function clearAll() {
        if (pageRegistry.length === 0) return;

        if (!confirm('¿Eliminar todas las ' + pageRegistry.length + ' páginas cargadas? Esta acción no se puede deshacer.')) {
            return;
        }

        // Limpiar DOM
        while (dom.workspace.firstChild) {
            dom.workspace.removeChild(dom.workspace.firstChild);
        }

        // Limpiar datos
        pageRegistry = [];
        pdfDocumentsData.clear();

        // Actualizar UI
        dom.btnGenerate.disabled = true;
        dom.btnClearAll.disabled = true;
        updateStatus(null);

        showToast('Workspace limpiado.', 'info');
    }

    /* ==========================================================
       MÓDULO: Inicialización de Sortable (arrastre)
       ========================================================== */

    function initSortable() {
        if (typeof Sortable === 'undefined') {
            console.warn('SortableJS no está disponible. El ordenamiento por arrastre no funcionará, pero la app sigue operativa.');
            return;
        }

        try {
            new Sortable(dom.workspace, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                delay: 100,
                delayOnTouchOnly: true,
                onEnd: function () {
                    syncRegistryWithDOM();
                }
            });
        } catch (e) {
            console.warn('No se pudo inicializar Sortable:', e.message);
        }
    }

    /* ==========================================================
       MÓDULO: Eventos de la zona de carga
       ========================================================== */

    function initDropZone() {
        // Clic → abrir diálogo de archivos
        dom.dropZone.addEventListener('click', function () {
            dom.fileInput.click();
        });

        // Teclado: Enter / Espacio → abrir diálogo
        dom.dropZone.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dom.fileInput.click();
            }
        });

        // Drag & Drop
        var dragEvents = ['dragover', 'dragenter'];
        dragEvents.forEach(function (evName) {
            dom.dropZone.addEventListener(evName, function (e) {
                e.preventDefault();
                dom.dropZone.classList.add('drag-over');
            });
        });

        var leaveEvents = ['dragleave', 'drop'];
        leaveEvents.forEach(function (evName) {
            dom.dropZone.addEventListener(evName, function (e) {
                e.preventDefault();
                dom.dropZone.classList.remove('drag-over');
            });
        });

        dom.dropZone.addEventListener('drop', function (e) {
            processFiles(e.dataTransfer.files);
        });

        dom.fileInput.addEventListener('change', function (e) {
            processFiles(e.target.files);
        });
    }

    /* ==========================================================
       MÓDULO: Atajos de teclado globales
       ========================================================== */

    function initKeyboardShortcuts() {
        document.addEventListener('keydown', function (e) {
            // Solo interceptar si el foco NO está en un input/textarea/select
            var tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
            var isEditable = (tag === 'input' || tag === 'textarea' || tag === 'select' ||
                              document.activeElement.isContentEditable);

            // Suprimir / Backspace → eliminar páginas seleccionadas
            if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditable) {
                var selected = dom.workspace.querySelectorAll('.page-card.selected');
                if (selected.length > 0) {
                    e.preventDefault();
                    selected.forEach(function (card) { card.remove(); });
                    syncRegistryWithDOM();
                }
            }

            // Ctrl+A → seleccionar todas las páginas
            if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !isEditable) {
                // Solo si el foco está en el workspace o en ningún input
                if (dom.workspace.contains(document.activeElement) || document.activeElement === document.body) {
                    e.preventDefault();
                    var allCards = dom.workspace.querySelectorAll('.page-card');
                    allCards.forEach(function (card) { card.classList.add('selected'); });
                }
            }

            // Escape → deseleccionar todo
            if (e.key === 'Escape' && !isEditable) {
                var allSelected = dom.workspace.querySelectorAll('.page-card.selected');
                allSelected.forEach(function (card) { card.classList.remove('selected'); });
            }
        });
    }

    /* ==========================================================
       MÓDULO: Limpieza al descargar / salir
       ========================================================== */

    function initCleanup() {
        // Revocar todas las URLs de blob al cerrar la página
        window.addEventListener('beforeunload', function () {
            blobUrls.forEach(function (url) {
                try { URL.revokeObjectURL(url); } catch (e) { /* ignorar */ }
            });
            blobUrls.clear();
        });
    }

    /* ==========================================================
       MÓDULO: Arranque seguro
       ========================================================== */

    function bootstrap() {
        cacheDOM();

        // Validar que los elementos críticos existan
        if (!dom.workspace || !dom.dropZone || !dom.btnGenerate) {
            console.error('UNIFICADOR SEDAPAL: Faltan elementos críticos en el DOM. Verifica el HTML.');
            return;
        }

        // Año en el footer
        if (dom.currentYear) {
            dom.currentYear.textContent = new Date().getFullYear();
        }

        // Inicializar módulos
        initDropZone();
        initSortable();
        initKeyboardShortcuts();
        initCleanup();

        // Evento del botón de unificación
        dom.btnGenerate.addEventListener('click', unifyAndDownload);

        // Evento del botón de limpieza
        dom.btnClearAll.addEventListener('click', clearAll);

        // Estado inicial
        dom.btnGenerate.disabled = true;
        dom.btnClearAll.disabled = true;

        console.log('UNIFICADOR SEDAPAL — Inicializado correctamente.');
    }

    /* ==========================================================
       ARRANQUE: DOMContentLoaded o inmediato si el DOM ya está listo
       ========================================================== */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        // DOM ya cargado (por posición del script al final del body)
        bootstrap();
    }

})();
