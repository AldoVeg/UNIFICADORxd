/* ═══════════════════════════════════════════════
   index.js — Generador de PDF SEDAPAL (Fortificado)
   IIFE estricto · Validación CDN · Compresión de
   imágenes · Canvas offscreen · Foleo Inverso Opcional
   ═══════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Guard: DOM aún no listo ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ═══════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════ */
  function init() {

    /* ── Validación de CDNs ── */
    if (typeof html2canvas === 'undefined') {
      showToast('Librería html2canvas no disponible. Verifica tu conexión.', 'error');
      return;
    }
    if (typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF === 'undefined') {
      showToast('Librería jsPDF no disponible. Verifica tu conexión.', 'error');
      return;
    }

    /* ── Referencias DOM cacheadas ── */
    var DOM = {
      tipoEvento:       document.getElementById('tipoEvento'),
      comboSub:         document.getElementById('subCategoria'),
      inputInstitucion: document.getElementById('institucion'),
      inputDistrito:    document.getElementById('distrito'),
      inputFecha:       document.getElementById('fecha'),
      chkFoleo:         document.getElementById('chkFoleo'), // Nuevo: Casillero opcional de foleo
      btnGenerar:       document.getElementById('btnGenerar'),
      overlay:          document.getElementById('loading-overlay'),
      loadingText:      document.getElementById('loading-text'),
      progressBar:      document.getElementById('progress-bar'),
      template:         document.getElementById('pdf-template'),
      offscreenCanvas:  document.getElementById('offscreen-canvas'),
      cdnError:         document.getElementById('cdn-error')
    };

    /* ── Estado interno ── */
    var imagenes = { 1: null, 2: null, 3: null, 4: null };
    var imagenesComprimidas = { 1: null, 2: null, 3: null, 4: null };
    var btnOriginalText = DOM.btnGenerar ? DOM.btnGenerar.innerHTML : 'Generar PDF';
    var isGenerating = false;

    /* ── Diccionario de subcategorías ── */
    var subCategoriasPorEvento = {
      "VISITA_IE":        ["INSTITUCIÓN EDUCATIVA", "COLEGIO"],
      "VISITA_ADULTOS":   ["UNIVERSIDAD NACIONAL", "UNIVERSIDAD PRIVADA"],
      "TALLER_IE":        ["UNIVERSIDAD NACIONAL", "UNIVERSIDAD PRIVADA", "INSTITUTO", "INSTITUCIÓN EDUCATIVA", "COLEGIO", "CEBA", "INICIAL", "NIDO"],
      "TALLER_EMPRESAS":  ["SEDAPAL", "MUNICIPALIDAD", "UNIVERSIDAD NACIONAL", "UNIVERSIDAD PRIVADA", "CENTRO COMERCIAL"],
      "TALLER_COMUNIDAD": ["MERCADO", "URBANIZACIÓN", "ASOCIACIÓN", "A.H."]
    };

    /* ── Tamaño máximo de imagen (bytes) ── */
    var MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

    /* ── Dimensiones de compresión ── */
    var COMPRESS_WIDTH  = 1600;
    var COMPRESS_HEIGHT = 1200;
    var COMPRESS_QUALITY = 0.85;

    /* ═══════════════════════════════════════════════
       UTILIDADES
       ═══════════════════════════════════════════════ */

    // Formatea números a 3 dígitos (Ej: 1 -> "001", 10 -> "010")
    function padFolio(numero) {
      return ('000' + numero).slice(-3);
    }

    function showToast(msg, type) {
      var container = document.getElementById('toast-container');
      if (!container) return;
      var toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'error');
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

    function formatearFecha(valor) {
      if (!valor) return '';
      var partes = valor.split('-');
      return partes[2] + '.' + partes[1] + '.' + partes[0];
    }

    function obtenerTituloPDF(valor) {
      if (valor === 'VISITA_IE') return 'VISITA DE INSTITUCIÓN<br>EDUCATIVA A LA PLANTA';
      if (valor === 'VISITA_ADULTOS')   return 'VISITA DE ADULTOS A LA PLANTA';
      if (valor === 'TALLER_IE')        return 'TALLER A INSTITUCIONES EDUCATIVAS';
      if (valor === 'TALLER_EMPRESAS')  return 'TALLER A EMPRESAS';
      if (valor === 'TALLER_COMUNIDAD') return 'TALLER A LA COMUNIDAD';
      return '';
    }

    function obtenerNombreShortFile(nombreIngresado) {
      var texto = (nombreIngresado || '').toUpperCase().trim();
      texto = texto.replace(/[^A-Z0-9\s\-_]/g, '');
      texto = texto.replace(/\s+/g, '_').replace(/_+/g, '_').replace(/-+/g, '-');
      return texto || 'documento';
    }

    function ajustarFuenteAdaptativa(elementoId, tamanoMaximoBase, forzarUnaFila) {
      var el = document.getElementById(elementoId);
      if (!el) return;
      if (forzarUnaFila) {
        el.style.whiteSpace = 'nowrap';
      } else {
        el.style.whiteSpace = 'normal';
      }
      el.style.fontSize = tamanoMaximoBase + 'px';
      var anchoContenedor = (el.parentElement && el.parentElement.clientWidth) || 682;
      var anchoTexto = el.scrollWidth;
      if (anchoTexto > anchoContenedor) {
        var nuevoTamano = Math.floor((anchoContenedor / anchoTexto) * tamanoMaximoBase);
        if (nuevoTamano < 14) nuevoTamano = 14;
        el.style.fontSize = nuevoTamano + 'px';
      }
    }

    /* ═══════════════════════════════════════════════
       COMPRESIÓN DE IMAGEN (Canvas Offscreen)
       ═══════════════════════════════════════════════ */
    function comprimirImagen(dataURL, slot) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var canvas = DOM.offscreenCanvas;
          if (!canvas) { resolve(dataURL); return; }
          var ctx = canvas.getContext('2d');

          var w = img.width;
          var h = img.height;
          var ratio = Math.min(COMPRESS_WIDTH / w, COMPRESS_HEIGHT / h, 1);

          canvas.width  = Math.round(w * ratio);
          canvas.height = Math.round(h * ratio);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          var compressed = canvas.toDataURL('image/jpeg', COMPRESS_QUALITY);
          imagenesComprimidas[slot] = compressed;

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          resolve(compressed);
        };
        img.onerror = function () {
          imagenesComprimidas[slot] = dataURL;
          resolve(dataURL);
        };
        img.src = dataURL;
      });
    }

    /* ═══════════════════════════════════════════════
       VALIDACIÓN DE CAMPOS
       ═══════════════════════════════════════════════ */
    function validarCampos() {
      var errores = [];

      if (!DOM.tipoEvento || !DOM.tipoEvento.value) {
        errores.push('Selecciona un tipo de evento.');
        if (DOM.tipoEvento) DOM.tipoEvento.classList.add('input-error');
      } else {
        if (DOM.tipoEvento) DOM.tipoEvento.classList.remove('input-error');
      }

      if (!DOM.comboSub || !DOM.comboSub.value) {
        errores.push('Selecciona el tipo de institución.');
        if (DOM.comboSub) DOM.comboSub.classList.add('input-error');
      } else {
        if (DOM.comboSub) DOM.comboSub.classList.remove('input-error');
      }

      if (!DOM.inputInstitucion || !DOM.inputInstitucion.value.trim()) {
        errores.push('Ingresa el nombre de la institución.');
        if (DOM.inputInstitucion) DOM.inputInstitucion.classList.add('input-error');
      } else {
        if (DOM.inputInstitucion) DOM.inputInstitucion.classList.remove('input-error');
      }

      if (!DOM.inputDistrito || !DOM.inputDistrito.value.trim()) {
        errores.push('Ingresa el distrito.');
        if (DOM.inputDistrito) DOM.inputDistrito.classList.add('input-error');
      } else {
        if (DOM.inputDistrito) DOM.inputDistrito.classList.remove('input-error');
      }

      if (!DOM.inputFecha || !DOM.inputFecha.value) {
        errores.push('Selecciona la fecha.');
        if (DOM.inputFecha) DOM.inputFecha.classList.add('input-error');
      } else {
        if (DOM.inputFecha) DOM.inputFecha.classList.remove('input-error');
      }

      for (var i = 1; i <= 4; i++) {
        if (!imagenes[i]) {
          errores.push('Selecciona la Foto ' + i + '.');
          break;
        }
      }

      return errores;
    }

    /* ═══════════════════════════════════════════════
       GENERACIÓN DEL PDF
       ═══════════════════════════════════════════════ */
    function generarPDF() {
      if (isGenerating) return;

      var errores = validarCampos();
      if (errores.length > 0) {
        showToast(errores[0], 'error');
        return;
      }

      isGenerating = true;

      var tipoVal          = DOM.tipoEvento.value;
      var subCategoriaTexto = DOM.comboSub.value;
      var nombreInstitucion = DOM.inputInstitucion.value.trim().toUpperCase();
      var distrito          = DOM.inputDistrito.value.trim().toUpperCase();
      var fecha             = formatearFecha(DOM.inputFecha.value);

      DOM.btnGenerar.innerHTML = '<span class="btn-icon">⏳</span> Generando PDF...';
      DOM.btnGenerar.disabled = true;

      showLoader('Comprimiendo imágenes...', true);

      var promesas = [];
      for (var i = 1; i <= 4; i++) {
        promesas.push(comprimirImagen(imagenes[i], i));
      }

      Promise.all(promesas).then(function () {
        updateProgress(1, 3);
        DOM.loadingText.textContent = 'Preparando plantilla y logos...';

        var titulo = obtenerTituloPDF(tipoVal);
        var subtituloFormateado = (subCategoriaTexto + ' ' + nombreInstitucion + ' – ' + distrito).toUpperCase();

        // Rellenar plantilla estructural - Página 1
        var titulo1 = document.getElementById('pdf-titulo-1');
        var inst1 = document.getElementById('pdf-institucion-1');
        var fecha1 = document.getElementById('pdf-fecha-1');
        var foto1 = document.getElementById('pdf-foto-1');
        var foto2 = document.getElementById('pdf-foto-2');

        if (titulo1) titulo1.innerHTML = titulo;
        if (inst1) inst1.textContent = subtituloFormateado;
        if (fecha1) fecha1.textContent = fecha;
        if (foto1) foto1.src = imagenesComprimidas[1];
        if (foto2) foto2.src = imagenesComprimidas[2];

        // Rellenar plantilla estructural - Página 2
        var titulo2 = document.getElementById('pdf-titulo-2');
        var inst2 = document.getElementById('pdf-institucion-2');
        var fecha2 = document.getElementById('pdf-fecha-2');
        var foto3 = document.getElementById('pdf-foto-3');
        var foto4 = document.getElementById('pdf-foto-4');

        if (titulo2) titulo2.innerHTML = titulo;
        if (inst2) inst2.textContent = subtituloFormateado;
        if (fecha2) fecha2.textContent = fecha;
        if (foto3) foto3.src = imagenesComprimidas[3];
        if (foto4) foto4.src = imagenesComprimidas[4];

        // ── LÓGICA DE FOLEO INVERSO OPCIONAL ──
        var aplicarFoleo = DOM.chkFoleo ? DOM.chkFoleo.checked : false;
        var paginasEnPlantilla = document.querySelectorAll('.pdf-pagina').length || 2; 
        
        var folioP1 = document.getElementById('pdf-folio-1');
        var folioP2 = document.getElementById('pdf-folio-2');

        if (aplicarFoleo) {
          // Página 1 recibe el número mayor (Ej: 002)
          if (folioP1) folioP1.textContent = padFolio(paginasEnPlantilla);
          // Página 2 recibe el número menor (Ej: 001)
          if (folioP2) folioP2.textContent = padFolio(paginasEnPlantilla - 1);
        } else {
          // Limpiar si el usuario no activó la opción
          if (folioP1) folioP1.textContent = '';
          if (folioP2) folioP2.textContent = '';
        }

        // Ubicar la plantilla de forma segura
        DOM.template.style.cssText = 'display:block; position:fixed; top:0; left:0; z-index:9999; opacity:0.01; pointer-events:none;';

        // Esperar descarga real del Logo PNG y Fotos
        var todasLasImagenes = Array.from(DOM.template.querySelectorAll('img'));
        var promesasCargaVisual = todasLasImagenes.map(function (img) {
          if (img.complete) return Promise.resolve();
          return new Promise(function (resolveReady) {
            img.onload = resolveReady;
            img.onerror = resolveReady; 
          });
        });

        Promise.all(promesasCargaVisual).then(function () {
          // Ajuste adaptativo
          ajustarFuenteAdaptativa('pdf-institucion-1', 25, true);
          ajustarFuenteAdaptativa('pdf-institucion-2', 25, true);
          var esDosFilas = (tipoVal === 'VISITA_IE');
          ajustarFuenteAdaptativa('pdf-titulo-1', 38, !esDosFilas);
          ajustarFuenteAdaptativa('pdf-titulo-2', 38, !esDosFilas);

          updateProgress(2, 3);
          DOM.loadingText.textContent = 'Renderizando páginas...';

          setTimeout(function () {
            var paginas = Array.from(document.querySelectorAll('.pdf-pagina'));
            var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

            function capturarPagina(index) {
              if (index >= paginas.length) {
                var nombreCortoLimpio = obtenerNombreShortFile(nombreInstitucion);
                var nombreFinalArchivo = 'F-(' + fecha + ')-' + nombreCortoLimpio + '.pdf';

                updateProgress(3, 3);
                DOM.loadingText.textContent = 'Guardando...';

                try {
                  doc.save(nombreFinalArchivo);
                  showToast('PDF generado exitosamente: ' + nombreFinalArchivo, 'success');
                } catch (e) {
                  showToast('Error al guardar el PDF: ' + e.message, 'error');
                }

                DOM.template.style.cssText = '';
                DOM.btnGenerar.innerHTML = btnOriginalText;
                DOM.btnGenerar.disabled = false;
                isGenerating = false;
                hideLoader();
                return;
              }

              var paginaActual = index + 1;
              DOM.loadingText.textContent = 'Renderizando página ' + paginaActual + ' de ' + paginas.length + '...';

              html2canvas(paginas[index], {
                scale: 2,           
                useCORS: true,      
                allowTaint: true,   
                logging: false,
                width: 794,
                height: 1123
              }).then(function (canvas) {
                var imgData = canvas.toDataURL('image/jpeg', 0.92);
                if (index > 0) doc.addPage();
                doc.addImage(imgData, 'JPEG', 0, 0, 210, 297);

                canvas.width = 0;
                canvas.height = 0;

                capturarPagina(index + 1);
              }).catch(function (error) {
                console.error('Error en html2canvas:', error);
                showToast('Error al renderizar la página ' + paginaActual + '. Intenta de nuevo.', 'error');
                DOM.template.style.cssText = '';
                DOM.btnGenerar.innerHTML = btnOriginalText;
                DOM.btnGenerar.disabled = false;
                isGenerating = false;
                hideLoader();
              });
            }

            capturarPagina(0);
          }, 250);
        });

      }).catch(function (error) {
        console.error('Error en compresión:', error);
        showToast('Error al procesar las imágenes.', 'error');
        DOM.btnGenerar.innerHTML = btnOriginalText;
        DOM.btnGenerar.disabled = false;
        isGenerating = false;
        hideLoader();
      });
    }

    /* ═══════════════════════════════════════════════
       EVENT LISTENERS
       ═══════════════════════════════════════════════ */

    if (DOM.inputInstitucion) {
      DOM.inputInstitucion.addEventListener('input', function () {
        this.value = this.value.toUpperCase();
        this.classList.remove('input-error');
      });
    }
    if (DOM.inputDistrito) {
      DOM.inputDistrito.addEventListener('input', function () {
        this.value = this.value.toUpperCase();
        this.classList.remove('input-error');
      });
    }

    if (DOM.tipoEvento) {
      DOM.tipoEvento.addEventListener('change', function () {
        var tipo = this.value;
        this.classList.remove('input-error');

        if (!DOM.comboSub || !DOM.inputInstitucion) return;

        DOM.comboSub.innerHTML = '<option value="" disabled selected>-- Tipo --</option>';
        DOM.inputInstitucion.value = '';

        if (tipo && subCategoriasPorEvento[tipo]) {
          DOM.comboSub.disabled = false;
          DOM.inputInstitucion.disabled = false;
          DOM.inputInstitucion.placeholder = 'Escribe el nombre aquí...';

          subCategoriasPorEvento[tipo].forEach(function (opcion) {
            var opt = document.createElement('option');
            opt.value = opcion;
            opt.textContent = opcion;
            DOM.comboSub.appendChild(opt);
          });
        } else {
          DOM.comboSub.disabled = true;
          DOM.inputInstitucion.disabled = true;
          DOM.inputInstitucion.placeholder = 'Selecciona tipo de evento primero';
        }
      });
    }

    if (DOM.comboSub && DOM.inputInstitucion) {
      DOM.comboSub.addEventListener('change', function () {
        this.classList.remove('input-error');
        DOM.inputInstitucion.focus();
      });
    }

    if (DOM.inputFecha) {
      DOM.inputFecha.addEventListener('change', function () {
        this.classList.remove('input-error');
      });
    }

    [1, 2, 3, 4].forEach(function (n) {
      var input = document.getElementById('foto' + n);
      var formPreview = document.getElementById('form-preview' + n);

      if (!input) return;

      input.addEventListener('change', function () {
        var archivo = input.files[0];
        if (!archivo) return;

        if (!archivo.type.match(/^image\//)) {
          showToast('La Foto ' + n + ' debe ser una imagen (JPG, PNG, etc.).', 'error');
          input.value = '';
          return;
        }

        if (archivo.size > MAX_FILE_SIZE) {
          showToast('La Foto ' + n + ' excede los 15 MB. Usa una imagen más pequeña.', 'warning');
          input.value = '';
          return;
        }

        var reader = new FileReader();
        reader.onload = function (e) {
          imagenes[n] = e.target.result;
          if (formPreview) {
            formPreview.src = e.target.result;
            formPreview.classList.add('visible');
          }
        };
        reader.onerror = function () {
          showToast('Error al leer la Foto ' + n + '. Intenta de nuevo.', 'error');
        };
        reader.readAsDataURL(archivo);
      });
    });

    if (DOM.btnGenerar) {
      DOM.btnGenerar.addEventListener('click', generarPDF);
    }

    function checkEnableButton() {
      if (!DOM.btnGenerar || isGenerating) return;
      var hasEvento  = DOM.tipoEvento && DOM.tipoEvento.value;
      var hasSub     = DOM.comboSub && DOM.comboSub.value;
      var hasInst    = DOM.inputInstitucion && DOM.inputInstitucion.value.trim();
      var hasDist    = DOM.inputDistrito && DOM.inputDistrito.value.trim();
      var hasFecha   = DOM.inputFecha && DOM.inputFecha.value;
      var hasFotos   = imagenes[1] && imagenes[2] && imagenes[3] && imagenes[4];
      DOM.btnGenerar.disabled = !(hasEvento && hasSub && hasInst && hasDist && hasFecha && hasFotos);
    }

    var camposParaChequear = [DOM.tipoEvento, DOM.comboSub, DOM.inputInstitucion, DOM.inputDistrito, DOM.inputFecha];
    camposParaChequear.forEach(function (campo) {
      if (!campo) return;
      campo.addEventListener('change', checkEnableButton);
      if (campo.tagName === 'INPUT' && campo.type === 'text') {
        campo.addEventListener('input', checkEnableButton);
      }
    });

    var observer = new MutationObserver(checkEnableButton);
    [1, 2, 3, 4].forEach(function (n) {
      var preview = document.getElementById('form-preview' + n);
      if (preview) {
        observer.observe(preview, { attributes: true, attributeFilter: ['class', 'src'] });
      }
    });

    checkEnableButton();

    document.querySelectorAll('input, select').forEach(function (el) {
      el.addEventListener('focus', function () {
        this.classList.remove('input-error');
      });
    });

    console.log('✅ Generador de PDF SEDAPAL — inicializado correctamente.');
  }

})();
