pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

const workspace = document.getElementById('workspace');
const btnGenerate = document.getElementById('btn-generate');
const overlay = document.getElementById('loading-overlay');
const textStatus = document.getElementById('loading-text');
const progressBar = document.getElementById('progress-bar');

let pdfDocumentsData = new Map(); 
let pageRegistry = []; 

// Función segura para generar IDs sin depender del entorno de red (corrección de uso local)
const generateId = () => Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

new Sortable(workspace, {
    animation: 150,
    ghostClass: 'sortable-ghost',
    onEnd: () => syncRegistryWithDOM()
});

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
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        pdfDocumentsData.set(fileId, buffer);

        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        
        for (let i = 1; i <= pdf.numPages; i++) {
            const pageId = `${fileId}_${i}`;
            
            const page = await pdf.getPage(i);
            // Escala 0.15 para optimizar RAM en archivos de +350MB
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
    }

    btnGenerate.disabled = pageRegistry.length === 0;
    hideLoader();
}

function createCardInDOM(data) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.id = data.id;

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-page';
    btnDel.innerHTML = '✖';
    btnDel.onclick = (e) => {
        e.stopPropagation(); 
        workspace.removeChild(card);
        syncRegistryWithDOM();
    };

    const img = document.createElement('img');
    img.className = 'page-image';
    img.src = data.thumb;
    img.dataset.rotation = 0;

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
            
            const req = pageRegistry[i];
            const srcDoc = loadedDocs.get(req.fileId);
            const [copiedPage] = await finalPdf.copyPages(srcDoc, [req.pageIndex]);
            
            if (req.rotation !== 0) {
                const currentRot = copiedPage.getRotation().angle;
                copiedPage.setRotation(PDFLib.degrees(currentRot + req.rotation));
            }

            finalPdf.addPage(copiedPage);

            // Estructura fija de Foleo: 001, 002... en esquina superior derecha
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
