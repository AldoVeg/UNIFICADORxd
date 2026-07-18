// Validación segura del motor PDF.js
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
} else {
    alert("Error de red: No se pudo cargar el motor PDF. Revisa tu conexión.");
}

const workspace = document.getElementById('workspace');
const btnGenerate = document.getElementById('btn-generate');
const overlay = document.getElementById('loading-overlay');
const textStatus = document.getElementById('loading-text');
const progressBar = document.getElementById('progress-bar');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

let pdfDocumentsData = new Map();
let pageRegistry = [];
const generateId = () => Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

// Inicialización estable de Sortable (Arrastre visual)
new Sortable(workspace, {
    animation: 150,
    ghostClass: 'sortable-ghost',
    delay: 100, // Evita conflictos entre dar clic para seleccionar y arrastrar
    delayOnTouchOnly: true,
    onEnd: () => syncRegistryWithDOM()
});

// Eventos seguros para la zona de carga
dropZone.addEventListener('click', () => fileInput.click());

['dragover', 'dragenter'].forEach(e => dropZone.addEventListener(e, ev => { 
    ev.preventDefault(); 
    dropZone.classList.add('drag-over'); 
}));

['dragleave', 'drop'].forEach(e => dropZone.addEventListener(e, ev => { 
    ev.preventDefault(); 
    dropZone.classList.remove('drag-over'); 
}));

dropZone.addEventListener('drop', ev => processFiles(ev.dataTransfer.files));
fileInput.addEventListener('change', ev => processFiles(ev.target.files));

// Listener global: Borrar múltiples páginas con la tecla Suprimir
document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
        const selected = document.querySelectorAll('.page-card.selected');
        if (selected.length > 0) {
            selected.forEach(card => card.remove());
            syncRegistryWithDOM();
        }
    }
});

async function processFiles(files) {
    // FILTRO FORTIFICADO: Verifica el MIME type o la extensión del archivo
    const pdfs = Array.from(files).filter(f => 
        f.type === 'application/pdf' || 
        f.name.toLowerCase().endsWith('.pdf')
    );

    if (pdfs.length === 0) {
        alert("Por favor, sube únicamente archivos en formato PDF.");
        return;
    }

    showLoader('Procesando páginas...', true);
    btnGenerate.disabled = true;

    for (const file of pdfs) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        pdfDocumentsData.set(fileId, buffer);

        try {
            const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
            const totalPages = pdf.numPages;
            
            for (let i = 1; i <= totalPages; i++) {
                updateProgress(i, totalPages);
                
                // Micro-pausa obligatoria para evitar congelamiento de RAM
                if (i % 5 === 0) await new Promise(r => setTimeout(r, 1)); 

                const pageId = `${fileId}_${i}`;
                const page = await pdf.getPage(i);
                
                const viewport = page.getViewport({ scale: 0.15 }); 
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

                const nodeData = {
                    id: pageId,
                    fileId: fileId,
                    pageIndex: i - 1, 
                    rotation: 0,
                    thumb: canvas.toDataURL('image/jpeg', 0.5) 
                };
                
                pageRegistry.push(nodeData);
                createCardInDOM(nodeData);
            }
        } catch (error) {
            console.error("Error al leer el archivo PDF: ", error);
        }
    }

    btnGenerate.disabled = pageRegistry.length === 0;
    hideLoader();
    // Limpiamos el input para permitir subir el mismo archivo dos veces si el usuario lo desea
    fileInput.value = "";
}

function createCardInDOM(data) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.id = data.id;

    // Lógica propia e irrompible de Selección Múltiple (clic simple)
    card.addEventListener('click', (e) => {
        // Ignora el clic si se hizo en el botón de borrar
        if (e.target.classList.contains('btn-delete-page')) return;
        card.classList.toggle('selected');
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-page';
    btnDel.innerHTML = '✖';
    btnDel.onclick = (e) => {
        e.stopPropagation(); 
        
        // Si hay varios seleccionados y hacemos clic en la X de uno de ellos, se borran todos
        const selected = document.querySelectorAll('.page-card.selected');
        if (selected.length > 0 && card.classList.contains('selected')) {
            selected.forEach(c => c.remove());
        } else {
            card.remove(); // Borra solo esta si no estaba seleccionada
        }
        syncRegistryWithDOM();
    };

    const img = document.createElement('img');
    img.className = 'page-image';
    img.src = data.thumb;
    img.dataset.rotation = 0;

    // Rotación con Doble Clic
    card.ondblclick = (e) => {
        e.stopPropagation();
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

function syncRegistryWithDOM() {
    const newOrder = [];
    Array.from(workspace.children).forEach(card => {
        const record = pageRegistry.find(p => p.id === card.dataset.id);
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

        for (const [fileId, buffer] of pdfDocumentsData.entries()) {
            loadedDocs.set(fileId, await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true }));
        }

        const font = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
        
        for (let i = 0; i < pageRegistry.length; i++) {
            updateProgress(i, pageRegistry.length);
            
            // Chunking en compilación 
            if (i % 10 === 0) await new Promise(r => setTimeout(r, 1)); 
            
            const req = pageRegistry[i];
            const srcDoc = loadedDocs.get(req.fileId);
            const [copiedPage] = await finalPdf.copyPages(srcDoc, [req.pageIndex]);
            
            if (req.rotation !== 0) {
                const currentRot = copiedPage.getRotation().angle;
                copiedPage.setRotation(PDFLib.degrees(currentRot + req.rotation));
            }

            finalPdf.addPage(copiedPage);

            if (applyFoleo) {
                const fStr = folioNum.toString().padStart(3, '0');
                const { width, height } = copiedPage.getSize();
                
                copiedPage.drawRectangle({
                    x: width - 40, y: height - 25,
                    width: 30, height: 16,
                    color: PDFLib.rgb(1, 1, 1)
                });

                copiedPage.drawText(fStr, {
                    x: width - 36, y: height - 21,
                    size: 11, font: font,
                    color: PDFLib.rgb(0, 0, 0)
                });
                folioNum++;
            }
        }

        const saveOptions = optimize ? { useObjectStreams: true } : {};
        const finalBytes = await finalPdf.save(saveOptions);

        const blob = new Blob([finalBytes], { type: 'application/pdf' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `SEDAPAL_Unificado_${new Date().toISOString().split('T')[0]}.pdf`;
        link.click();

    } catch (e) {
        alert("Error crítico durante la unificación: " + e.message);
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
