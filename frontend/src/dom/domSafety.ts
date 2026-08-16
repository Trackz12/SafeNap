function isNotFoundError(e: unknown): boolean {
    return (
        e instanceof DOMException &&
        (e.name === 'NotFoundError' || e.name === 'NOT_FOUND_ERR' || e.code === 8)
    );
}

/**
 * iOS (Safari e Chrome) pode alterar o DOM fora do controle do React ao aplicar
 * recursos como traducao automatica, ajustes de texto ou realce. Quando isso
 * acontece, o reconciler do React lanca NotFoundError em removeChild e derruba
 * a aplicacao inteira via ErrorBoundary.
 *
 * Esta rede de seguranca tolera somente esse caso especifico: se o no ja nao
 * pertence mais ao pai esperado, simplesmente nao ha nada a fazer ali.
 * Qualquer outro erro continua sendo relancado normalmente.
 */
export function installDomSafetyNet(): void {
    const w = window as unknown as { __safenapDomPatched?: boolean };
    if (w.__safenapDomPatched) return;
    w.__safenapDomPatched = true;

    const originalRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
        try {
            return originalRemoveChild.call(this, child) as T;
        } catch (e) {
            if (isNotFoundError(e)) {
                console.warn('[dom-safety] removeChild tolerado: no ja removido por agente externo (traducao/SO).');
                return child;
            }
            throw e;
        }
    };

    const originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, referenceNode: Node | null): T {
        try {
            return originalInsertBefore.call(this, node, referenceNode) as T;
        } catch (e) {
            if (isNotFoundError(e)) {
                console.warn('[dom-safety] insertBefore sem referencia valida: anexando ao final.');
                return originalInsertBefore.call(this, node, null) as T;
            }
            throw e;
        }
    };

    const originalReplaceChild = Node.prototype.replaceChild;
    Node.prototype.replaceChild = function <T extends Node>(this: Node, newChild: Node, oldChild: T): T {
        try {
            return originalReplaceChild.call(this, newChild, oldChild) as T;
        } catch (e) {
            if (isNotFoundError(e)) {
                console.warn('[dom-safety] replaceChild sem no de referencia: inserindo novo no ao final.');
                return originalInsertBefore.call(this, newChild, null) as T;
            }
            throw e;
        }
    };
}
