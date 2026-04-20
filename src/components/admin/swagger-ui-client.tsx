"use client";

import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";

export function SwaggerUIClient() {
  return (
    <div className="swagger-dark-wrap">
      <SwaggerUI url="/api/openapi" docExpansion="none" defaultModelsExpandDepth={-1} />
      <style>{`
        .swagger-dark-wrap .swagger-ui { background: transparent; color: inherit; }
        .swagger-dark-wrap .swagger-ui .info { margin-bottom: 1.5rem; }
        .swagger-dark-wrap .swagger-ui .info .title { color: #f4f4f5; }
        .swagger-dark-wrap .swagger-ui .info p,
        .swagger-dark-wrap .swagger-ui .info li { color: #a1a1aa; }

        .swagger-dark-wrap .swagger-ui .topbar { display: none; }

        .swagger-dark-wrap .swagger-ui .opblock-tag {
          border-bottom: 1px solid #3f3f46;
          color: #f4f4f5;
        }
        .swagger-dark-wrap .swagger-ui .opblock-tag:hover { background: #27272a; }
        .swagger-dark-wrap .swagger-ui .opblock-tag-section h4 span { color: #a1a1aa; font-weight: 400; }

        .swagger-dark-wrap .swagger-ui .opblock {
          background: #18181b;
          border-color: #3f3f46;
          box-shadow: none;
          border-radius: 6px;
          margin-bottom: 4px;
        }
        .swagger-dark-wrap .swagger-ui .opblock .opblock-summary { border-bottom: none; }
        .swagger-dark-wrap .swagger-ui .opblock .opblock-summary-description { color: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui .opblock-body { background: #09090b; border-radius: 0 0 6px 6px; }
        .swagger-dark-wrap .swagger-ui .opblock-section-header {
          background: #18181b;
          border-bottom: 1px solid #27272a;
        }
        .swagger-dark-wrap .swagger-ui .opblock-section-header h4 { color: #f4f4f5; }

        .swagger-dark-wrap .swagger-ui .opblock.opblock-get { border-color: #1d4ed8; background: #1e1b4b22; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-get .opblock-summary { background: #1e1b4b22; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-post { border-color: #15803d; background: #14532d22; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-post .opblock-summary { background: #14532d22; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-put { border-color: #b45309; background: #451a0322; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-put .opblock-summary { background: #451a0322; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-patch { border-color: #7c3aed; background: #2e1065 22; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-patch .opblock-summary { background: #2e106522; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-delete { border-color: #b91c1c; background: #450a0a22; }
        .swagger-dark-wrap .swagger-ui .opblock.opblock-delete .opblock-summary { background: #450a0a22; }

        .swagger-dark-wrap .swagger-ui table thead tr th,
        .swagger-dark-wrap .swagger-ui table thead tr td { color: #a1a1aa; border-color: #3f3f46; }
        .swagger-dark-wrap .swagger-ui table tbody tr td { color: #d4d4d8; border-color: #3f3f46; }
        .swagger-dark-wrap .swagger-ui .parameter__name { color: #f4f4f5; }
        .swagger-dark-wrap .swagger-ui .parameter__type { color: #818cf8; }
        .swagger-dark-wrap .swagger-ui .parameter__in { color: #6b7280; }
        .swagger-dark-wrap .swagger-ui .parameter__deprecated { color: #f87171; }
        .swagger-dark-wrap .swagger-ui .parameter__empty-value-toggle input[type=checkbox] { accent-color: #818cf8; }

        .swagger-dark-wrap .swagger-ui input[type=text],
        .swagger-dark-wrap .swagger-ui input[type=password],
        .swagger-dark-wrap .swagger-ui input[type=search],
        .swagger-dark-wrap .swagger-ui textarea,
        .swagger-dark-wrap .swagger-ui select {
          background: #27272a;
          color: #f4f4f5;
          border: 1px solid #3f3f46;
          border-radius: 4px;
        }
        .swagger-dark-wrap .swagger-ui input[type=text]:focus,
        .swagger-dark-wrap .swagger-ui textarea:focus { outline-color: #6366f1; }

        .swagger-dark-wrap .swagger-ui .btn { border-radius: 4px; }
        .swagger-dark-wrap .swagger-ui .btn.execute { background: #6366f1; border-color: #6366f1; }
        .swagger-dark-wrap .swagger-ui .btn.execute:hover { background: #4f46e5; border-color: #4f46e5; }
        .swagger-dark-wrap .swagger-ui .btn.cancel { border-color: #3f3f46; color: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui .btn.authorize { background: #15803d; border-color: #15803d; color: white; }
        .swagger-dark-wrap .swagger-ui .btn.authorize svg { fill: white; }
        .swagger-dark-wrap .swagger-ui .authorization__btn.locked svg { fill: #4ade80; }
        .swagger-dark-wrap .swagger-ui .authorization__btn.unlocked svg { fill: #71717a; }

        .swagger-dark-wrap .swagger-ui .model-container { background: #18181b; border-radius: 4px; }
        .swagger-dark-wrap .swagger-ui .model-box { background: #18181b; }
        .swagger-dark-wrap .swagger-ui .model { color: #d4d4d8; }
        .swagger-dark-wrap .swagger-ui .model .property { color: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui section.models { border: 1px solid #3f3f46; border-radius: 6px; }
        .swagger-dark-wrap .swagger-ui section.models h4 { color: #f4f4f5; border-color: #3f3f46; }
        .swagger-dark-wrap .swagger-ui section.models.is-open { background: #18181b; }

        .swagger-dark-wrap .swagger-ui .response-col_status { color: #a3e635; }
        .swagger-dark-wrap .swagger-ui .response-col_description { color: #d4d4d8; }
        .swagger-dark-wrap .swagger-ui .responses-inner { background: transparent; }
        .swagger-dark-wrap .swagger-ui .response-control-media-type__accept-message { color: #6b7280; }

        .swagger-dark-wrap .swagger-ui .highlight-code pre,
        .swagger-dark-wrap .swagger-ui .microlight,
        .swagger-dark-wrap .swagger-ui code {
          background: #09090b !important;
          color: #d4d4d8 !important;
          border-radius: 4px;
        }

        .swagger-dark-wrap .swagger-ui .scheme-container { background: #09090b; padding: 0.75rem 1rem; }
        .swagger-dark-wrap .swagger-ui select { background: #27272a; color: #f4f4f5; border-color: #3f3f46; }

        .swagger-dark-wrap .swagger-ui .dialog-ux .modal-ux {
          background: #18181b;
          border: 1px solid #3f3f46;
          border-radius: 8px;
        }
        .swagger-dark-wrap .swagger-ui .dialog-ux .modal-ux-header {
          background: #09090b;
          border-bottom: 1px solid #3f3f46;
        }
        .swagger-dark-wrap .swagger-ui .dialog-ux .modal-ux-header h3 { color: #f4f4f5; }
        .swagger-dark-wrap .swagger-ui .dialog-ux .modal-ux-content { color: #d4d4d8; }
        .swagger-dark-wrap .swagger-ui .dialog-ux .modal-ux-content h4 { color: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui .dialog-ux .modal-ux-content .scopes li label b,
        .swagger-dark-wrap .swagger-ui .dialog-ux .modal-ux-content code { color: #818cf8; }

        .swagger-dark-wrap .swagger-ui .renderedMarkdown p { color: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui label { color: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui p { color: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui svg { fill: #a1a1aa; }
        .swagger-dark-wrap .swagger-ui .arrow { fill: #71717a; }
        .swagger-dark-wrap .swagger-ui .expand-operation svg { fill: #f4f4f5; }

        .swagger-dark-wrap .swagger-ui .parameter__name.required span { color: #f87171; }
        .swagger-dark-wrap .swagger-ui .parameter__name.required::after { color: #f87171; }

        .swagger-dark-wrap .swagger-ui .loading-container .loading::before { border-top-color: #6366f1; }
      `}</style>
    </div>
  );
}
