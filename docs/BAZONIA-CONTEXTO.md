# BAZONIA - Manual de Contexto y Continuación
## Sistema de Marketplace Cross-Border E-Commerce

**Fecha:** 02 Enero 2026  
**Versión:** 1.4.1  
**Cliente:** Puerta a Puerta Cargo  
**Agencia:** SerMasivo

---

## 1. RESUMEN EJECUTIVO

BAZONIA es un marketplace que permite a clientes venezolanos comprar productos de tiendas estadounidenses (Amazon inicialmente, Walmart futuro) a través de la red logística de Puerta a Puerta Cargo. El sistema automatiza la obtención de precios en tiempo real, gestión de variantes y cálculo de envíos.

**Modelo de negocio:**
- Servicio gratuito para clientes
- Sin comisión sobre productos
- Ganancia incluida únicamente en costos de envío
- Sin gestión de devoluciones

---

## 2. ARQUITECTURA TÉCNICA

### 2.1 Stack Tecnológico

| Componente | Tecnología | URL/Ubicación |
|------------|------------|---------------|
| Frontend | WordPress + WooCommerce + Divi 5 | bazonia.sermasivo.com |
| Automatización | n8n (Docker) | n8n.sermasivo.com |
| Base de datos productos | Google Sheets MASTER | Ver sección 3 |
| API de productos | ZINC API | api.zinc.io |
| Plugin custom | Bazonia Frontend v1.4.1 | WordPress |
| Servidor | Digital Ocean Droplet | n8n-docker-caddy-n8n-1 |

### 2.2 Flujo de Datos

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  ZINC API   │────▶│    n8n      │────▶│Google Sheets│
│  (Amazon)   │     │  Workflows  │     │   MASTER    │
└─────────────┘     └─────────────┘     └─────────────┘
                           │                   │
                           ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐
                    │  WooCommerce│◀────│   Sync      │
                    │  (Productos)│     │  Workflow   │
                    └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Plugin    │◀──── Webhook tiempo real
                    │  Bazonia    │      (BAZONIA-GET-VARIANT)
                    └─────────────┘
```

---

## 3. GOOGLE SHEETS MASTER

**ID:** `1Uq4w6ybVS26Hl3-tbbfOOQFShIcPO_EAfdCBbLuAAkU`

**URL:** https://docs.google.com/spreadsheets/d/1Uq4w6ybVS26Hl3-tbbfOOQFShIcPO_EAfdCBbLuAAkU/edit

### Estructura de columnas principales:
- `ASIN` - Identificador Amazon
- `Title` - Nombre del producto
- `Price` - Precio actual USD
- `Main_Image` - URL imagen principal
- `Variants_JSON` - JSON con todas las variantes
- `Weight` - Peso en kg
- `Dimensions` - Dimensiones del producto
- `Rating` - Estrellas (pendiente corregir)
- `Category` - Categoría (pendiente mapping)

### Formato Variants_JSON:
```json
[
  {
    "id": "B0DZD9S5GC",
    "price": 799,
    "image": "",
    "specs": {
      "Capacity": "16GB Unified Memory, 256GB SSD Storage",
      "Color": "Midnight",
      "Set": "Without AppleCare+"
    }
  }
]
```

**IMPORTANTE:** El plugin busca variantes por `specs` (no `attributes`).

---

## 4. WORKFLOWS N8N

### 4.1 BAZONIA-WOO-SYNC (Sincronización)
- **ID:** OKfY4teGaEEAptOX
- **URL:** https://n8n.sermasivo.com/workflow/OKfY4teGaEEAptOX
- **Estado:** Funcional (ejecución manual)
- **Función:** Sincroniza productos desde ZINC API → Google Sheets → WooCommerce
- **Trigger futuro:** Cron schedule (cuando esté en producción)
- **Pendiente:** Fix rating/estrellas, mapping de categorías

### 4.2 BAZONIA-GET-VARIANT (Tiempo Real)
- **ID:** SNNTNZuZrnCcMBKw
- **URL:** https://n8n.sermasivo.com/workflow/SNNTNZuZrnCcMBKw
- **Estado:** ✅ ACTIVO en producción
- **Webhook:** https://n8n.sermasivo.com/webhook/bazonia-get-variant
- **Función:** Recibe ASIN, consulta ZINC API, retorna precio/imagen/stock
- **Método:** POST con `{ "asin": "B0XXXXXX" }`

### 4.3 BAZONIA-WOO-SYNC v2 (En construcción)
- **ID:** TJlCAEh6rJVqt4ll
- **URL:** https://n8n.sermasivo.com/workflow/TJlCAEh6rJVqt4ll
- **Estado:** 🚧 En desarrollo
- **Objetivo:** Sync más rápido y eficiente, actualizar MASTER con búsquedas de usuarios

---

## 5. PLUGIN BAZONIA FRONTEND

### 5.1 Versión Actual: 1.4.1

**Ubicación:** WordPress → Plugins → Bazonia Frontend

### 5.2 Funcionalidades Implementadas

| Función | Estado | Descripción |
|---------|--------|-------------|
| Detección de variantes | ✅ | Busca en JSON local por `specs` |
| Actualización precio | ✅ | Módulo Divi WC Price |
| Actualización stock | ✅ | Módulo Divi WC Stock |
| Actualización imagen | ✅ | Módulo Divi WC Images |
| Actualización peso | ✅ | Módulo Divi Additional Info |
| Webhook fallback | ✅ | Si no hay precio local, consulta n8n |
| Guardar precio en carrito | ✅ | Session storage + AJAX |
| Imagen correcta en carrito | ✅ | Filter woocommerce_cart_item_thumbnail |
| Pre-selección variante | ✅ | Primera variante con precio > 0 |

### 5.3 Archivos del Plugin

```
bazonia-frontend/
├── bazonia-frontend.php    # Clase principal, hooks, AJAX handlers
└── js/
    └── bazonia-frontend.js # Lógica frontend, eventos WooCommerce
```

### 5.4 Meta Fields WooCommerce

| Campo | Descripción |
|-------|-------------|
| `_bazonia_variants_json` | JSON con todas las variantes del producto |
| `_bazonia_store` | Tienda origen (amazon, walmart) |
| `_bazonia_parent_asin` | ASIN del producto padre |

### 5.5 Endpoints AJAX

| Action | Función |
|--------|---------|
| `bazonia_save_price` | Guarda precio/imagen en sesión antes de add to cart |

---

## 6. ESTRATEGIAS PENDIENTES DE IMPLEMENTAR

### 6.1 Sistema de Fallback para Errores API

**Problema:** Cuando ZINC API falla o está caído, el usuario ve "ERROR" en la página.

**Solución requerida:**
- Si webhook falla → mostrar último precio conocido del JSON local
- Si no hay precio local → mostrar "Precio no disponible" (no ERROR)
- Nunca mostrar errores técnicos al usuario final
- Log de errores silencioso para debugging

**Flujo propuesto:**
```
Usuario selecciona variante
    ↓
¿Hay precio en JSON local? 
    → SÍ: Mostrar precio local
    → NO: Llamar webhook
           ↓
       ¿Webhook exitoso?
           → SÍ: Mostrar precio + actualizar cache
           → NO: Mostrar "Consultando..." o último conocido
```

### 6.2 Cache Inteligente con Actualización Bidireccional

**Objetivo:** Reducir llamadas a ZINC API + acelerar carga + ahorrar dinero

**Concepto:**
Cuando el webhook BAZONIA-GET-VARIANT obtiene datos de ZINC, esa información se guarda de vuelta en el MASTER Sheet (columna `Variants_JSON`), completando la info de variantes que tenían `price: 0`.

**Flujo:**
```
1. Usuario selecciona variante con price=0 en JSON
2. Frontend llama webhook → n8n consulta ZINC
3. n8n retorna precio/imagen al frontend
4. n8n TAMBIÉN actualiza MASTER Sheet con ese precio
5. Próxima vez → precio ya está en JSON local → NO llama API
```

**Beneficios:**
- Primera búsqueda: ~2-3 seg (ZINC API)
- Búsquedas siguientes: ~100ms (JSON local)
- Ahorro estimado: 80-90% de llamadas API
- MASTER Sheet se auto-completa con el uso

**Implementación en n8n:**
- Agregar nodo después de "Format Response" en BAZONIA-GET-VARIANT
- Nodo Google Sheets: Update row donde SKU = parent_asin
- Actualizar solo el variant específico dentro del JSON

---

## 7. TO-DO LIST

### 🔴 Alta Prioridad

- [ ] **Fallback errores API** - Nunca mostrar ERROR al usuario, usar precio local o mensaje amigable
- [ ] **Cache bidireccional** - Webhook actualiza MASTER Sheet con precios obtenidos de ZINC
- [ ] **Skeleton loaders** - Agregar a todos los módulos Divi WooCommerce (precio, stock, imagen, peso)
- [ ] **Stripe integration** - Configurar método de pago
- [ ] **Sistema de órdenes** - Decidir: Hoja Google Sheets para almacén vs ZINC Orders API
- [ ] **Mapping categorías** - Script Google Sheets no mapea, agregar a n8n sync

### 🟡 Media Prioridad

- [ ] **Precio original tachado** - Mostrar precio regular vs precio oferta (viene de Amazon)
- [ ] **Recortar título checkout** - Como TiendaMia, título más corto en resumen
- [ ] **Rating/estrellas** - Fix en workflow sync, no está trayendo correctamente
- [ ] **Quitar precio duplicado** - El precio bajo botón ADD TO CART (ajuste Divi)

### 🟢 Baja Prioridad / Futuro

- [ ] **Walmart integration** - Agregar segunda tienda
- [ ] **Target integration** - Tercera tienda
- [ ] **Calculadora envío frontend** - Selector aéreo/marítimo con tiempos
- [ ] **Cache inteligente** - Actualizar MASTER con búsquedas usuarios (workflow v2)

---

## 8. CREDENCIALES Y ACCESOS

### Google Sheets
- **OAuth2 Credential ID:** EEUhtC7sFK3RuUT6

### WooCommerce API
- **HTTP Basic Auth ID:** ByMzQVlmLFBjkR0k
- **Nota:** Requiere "Include Credentials in Query" activado

### ZINC API
- **Autenticación:** Basic Auth (header manual en n8n)
- **Endpoint productos:** https://api.zinc.io/v1/products/{asin}?retailer=amazon

### Docker n8n
- **Container:** n8n-docker-caddy-n8n-1
- **Logs:** `docker logs n8n-docker-caddy-n8n-1 --tail 100`

---

## 9. DECISIONES TÉCNICAS TOMADAS

1. **ZINC API vs Apify:** Se migró de Apify a ZINC por mayor confiabilidad en datos de variantes.

2. **Búsqueda por `specs` no `attributes`:** El JSON de variantes usa estructura `specs` con keys legibles (Capacity, Color, Set).

3. **Session storage para carrito:** Los precios se guardan en `$_SESSION['bazonia_prices']` porque WooCommerce resetea precios de variaciones.

4. **Webhook tiempo real:** Si el JSON local no tiene precio (price=0), se consulta ZINC en tiempo real via n8n webhook.

5. **Sin productos nativos WooCommerce para inventario:** Los productos se sincronizan pero no se usa stock nativo, se valida contra ZINC.

---

## 10. COMANDOS ÚTILES

```bash
# Ver logs n8n
docker logs n8n-docker-caddy-n8n-1 --tail 100

# Reiniciar n8n
docker restart n8n-docker-caddy-n8n-1

# Test webhook variante
curl -X POST https://n8n.sermasivo.com/webhook/bazonia-get-variant \
  -H "Content-Type: application/json" \
  -d '{"asin":"B0DZD9S5GC"}'
```

---

## 11. CONTACTOS

- **Proyecto:** BAZONIA / Puerta a Puerta Cargo
- **Desarrollo:** SerMasivo - Agencia Digital
- **Responsable técnico:** Alvaro

---

## 12. HISTORIAL DE VERSIONES

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0.0 | - | Versión inicial |
| 1.3.0 | - | Integración Divi 5, búsqueda por specs |
| 1.4.0 | 02/01/2026 | Interceptor carrito, guardar precio en sesión |
| 1.4.1 | 02/01/2026 | Fix imagen correcta en carrito |
| 1.4.2 | 02/01/2026 | Fix reset variante, fallback errores, peso persistente |

---

*Documento generado para continuación de desarrollo en nuevas sesiones de chat.*
