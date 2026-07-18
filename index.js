// Configuración de Worker local para evitar bloqueos del navegador
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

const workspace = document.getElementById('workspace');
const btnGenerate = document.getElementById('btn-generate');
const overlay = document.getElementById('loading-overlay');
const textStatus = document.getElementById('loading-text');
const progressBar = document.getElementById('progress-bar');

let pdfDocumentsData = new Map(); // Almacena ArrayBuffers para optimizar RAM
let pageRegistry = []; // Control del orden visual y rotaciones

// Inicialización de Drag & Drop Libre (Librería SortableJS)
new Sortable(workspace, {
    animation: 150,
    ghostClass: 'sortable-ghost',
    onEnd: () => {
        syncRegistryWithDOM();
    }
});

// Eventos de la zona de carga
const dropZone = document.getElementById('drop-zone');
['dragover', 'dragenter'].forEach(e => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.add('drag-over'); }));
['dragleave', 'drop'].forEach(e => dropZone.addEventListener(e, ev => { ev.preventDefault(); dropZone.classList.remove('drag-over'); }));

dropZone.addEventListener('drop', ev => processFiles(ev.dataTransfer.files));
document.getElementById('file-input').addEventListener('change', ev => processFiles(ev.target.files));

async function processFiles(files) {
    const pdfs = Array.from(files).filter(f => f.type === 'application/pdf');
    if (!pdfs.length) return;

    showLoader('Leyendo estructura de archivos...');
    btnGenerate.disabled = true;

    for (const file of pdfs) {
        const fileId = crypto.randomUUID();
        const buffer = await file.arrayBuffer();
        pdfDocumentsData.set(fileId, buffer);

        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        
        for (let i = 1; i <= pdf.numPages; i++) {
            const pageId = `${fileId}_${i}`;
            
            // Renderizado diferido y de baja resolución para soportar archivos de +350MB
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 0.2 }); 
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

            const nodeData = {
                id: pageId,
                fileId: fileId,
                pageIndex: i - 1, // base 0 para pdf-lib
                rotation: 0,
                thumb: canvas.toDataURL('image/jpeg', 0.5) // Compresión base 64 rápida
            };
            
            pageRegistry.push(nodeData);
            createCardInDOM(nodeData);
        }
    }

    btnGenerate.disabled = pageRegistry.length === 0;
    hideLoader();
}

function createCardInDOM(data) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.id = data.id;

    // Botón eliminar
    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-page';
    btnDel.innerHTML = '✖';
    btnDel.onclick = (e) => {
        e.stopPropagation(); // Evita conflicto con el Drag & Drop
        workspace.removeChild(card);
        syncRegistryWithDOM();
    };

    // Imagen miniatura
    const img = document.createElement('img');
    img.className = 'page-image';
    img.src = data.thumb;
    img.dataset.rotation = 0;

    // Doble clic para rotar 90°
    card.ondblclick = () => {
        const currentRot = (parseInt(img.dataset.rotation) + 90) % 360;
        img.dataset.rotation = currentRot;
        img.style.transform = `rotate(${currentRot}deg)`;
        
        const regIndex = pageRegistry.findIndex(p => p.id === data.id);
        if(regIndex > -1) pageRegistry[regIndex].rotation = currentRot;
    };

    card.appendChild(btnDel);
    card.appendChild(img);
    workspace.appendChild(card);
}

// Mantiene sincronizado el array lógico con el movimiento físico hecho con el mouse
function syncRegistryWithDOM() {
    const newOrder = [];
    const domCards = Array.from(workspace.children);
    
    domCards.forEach(card => {
        const id = card.dataset.id;
        const record = pageRegistry.find(p => p.id === id);
        if(record) newOrder.push(record);
    });
    
    pageRegistry = newOrder;
    btnGenerate.disabled = pageRegistry.length === 0;
}

btnGenerate.addEventListener('click', async () => {
    if (pageRegistry.length === 0) return;
    
    showLoader('Compilando documento final...', true);
    const applyFoleo = document.getElementById('chk-foleo').checked;
    const optimize = document.getElementById('chk-optimize').checked;
    let folioNum = parseInt(document.getElementById('folio-start').value) || 1;

    try {
        const finalPdf = await PDFLib.PDFDocument.create();
        const loadedDocs = new Map();

        // Carga dinámica de documentos fuente en memoria pdf-lib
        for (const [fileId, buffer] of pdfDocumentsData.entries()) {
            loadedDocs.set(fileId, await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true }));
        }

        const font = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
        
        for (let i = 0; i < pageRegistry.length; i++) {
            updateProgress(i, pageRegistry.length);
            
            const req = pageRegistry[i];
            const srcDoc = loadedDocs.get(req.fileId);
            const [copiedPage] = await finalPdf.copyPages(srcDoc, [req.pageIndex]);
            
            // Aplicar rotación visual originada por el usuario
            if (req.rotation !== 0) {
                const currentRot = copiedPage.getRotation().angle;
                copiedPage.setRotation(PDFLib.degrees(currentRot + req.rotation));
            }

            finalPdf.addPage(copiedPage);

            // Aplicar Foleo Estricto (001, 002)
            if (applyFoleo) {
                const fStr = folioNum.toString().padStart(3, '0');
                const { width, height } = copiedPage.getSize();
                
                copiedPage.drawRectangle({
                    x: width - 45, y: height - 25,
                    width: 35, height: 15,
                    color: PDFLib.rgb(1, 1, 1)
                });

                copiedPage.drawText(fStr, {
                    x: width - 40, y: height - 20,
                    size: 11, font: font,
                    color: PDFLib.rgb(0, 0, 0)
                });
                folioNum++;
            }
        }

        // Parámetro de optimización de compresión base de pdf-lib
        const saveOptions = optimize ? { useObjectStreams: true } : {};
        const finalBytes = await finalPdf.save(saveOptions);

        const blob = new Blob([finalBytes], { type: 'application/pdf' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `SEDAPAL_Unificado_${new Date().getTime()}.pdf`;
        link.click();

    } catch (e) {
        alert("Error en la unificación: " + e.message);
    } finally {
        hideLoader();
    }
});

function showLoader(msg, withProgress = false) {
    textStatus.innerText = msg;
    overlay.classList.remove('hidden');
    progressBar.classList.toggle('hidden', !withProgress);
    if(withProgress) progressBar.value = 0;
}

function updateProgress(current, total) {
    progressBar.value = (current / total) * 100;
}

function hideLoader() {
    overlay.classList.add('hidden');
    progressBar.classList.add('hidden');
}