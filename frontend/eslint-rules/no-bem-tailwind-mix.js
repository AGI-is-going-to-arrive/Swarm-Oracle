/**
 * ESLint rule: no-bem-tailwind-mix
 *
 * Prevents mixing BEM class names and Tailwind utility classes on the same
 * JSX className attribute (including cn/clsx/twMerge calls).
 * This enforces the migration boundary: a node is either pure BEM (legacy)
 * or pure Tailwind (new), never both.
 */

const TAILWIND_PREFIXES = [
  'bg-', 'text-', 'font-', 'p-', 'px-', 'py-', 'pt-', 'pr-', 'pb-', 'pl-',
  'm-', 'mx-', 'my-', 'mt-', 'mr-', 'mb-', 'ml-', 'w-', 'h-', 'min-w-',
  'min-h-', 'max-w-', 'max-h-', 'flex', 'grid', 'gap-', 'rounded-',
  'border-', 'shadow-', 'opacity-', 'transition-', 'duration-', 'ease-',
  'z-', 'inset-', 'top-', 'right-', 'bottom-', 'left-', 'overflow-',
  'items-', 'justify-', 'self-', 'col-', 'row-', 'space-', 'divide-',
  'ring-', 'outline-', 'cursor-', 'pointer-events-', 'select-',
  'sr-only', 'not-sr-only', 'truncate', 'line-clamp-', 'aspect-',
];

const TAILWIND_MODIFIERS = [
  'hover:', 'focus:', 'active:', 'disabled:', 'group-hover:',
  'sm:', 'md:', 'lg:', 'xl:', '2xl:', 'dark:', 'motion-safe:', 'motion-reduce:',
];

const TAILWIND_EXACT = new Set([
  'flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute',
  'fixed', 'sticky', 'static', 'truncate', 'sr-only', 'not-sr-only',
  'isolate', 'container', 'inline-flex', 'inline-grid', 'inline-block',
]);

/**
 * Known BEM block classes from index.css.
 * These are single-word or hyphenated class names that don't contain __ or --
 * but are still BEM blocks used in the legacy codebase.
 */
const KNOWN_BEM_BLOCKS = new Set([
  'btn', 'btn-primary', 'btn-ghost', 'btn-secondary', 'btn-danger',
  'input', 'flat-card', 'badge', 'lang-switch',
  'input-view', 'result-archive', 'result-actions', 'result-action-bar',
  'debate-shell', 'debate-modal', 'debate-hero', 'debate-controls',
  'debate-situation-grid', 'debate-room-grid', 'debate-stage-summary-list',
  'debate-mobile-rail', 'debate-panel',
  'ending-chat-thread-chip', 'ending-chat-participant-card',
  'ending-chat-hotseat-pill', 'ending-chat-bubble', 'ending-chat-composer',
  'ending-chat-send', 'ending-chat-close', 'ending-chat-mode-pill',
  'ending-chat-overlay', 'ending-chat-inline-button', 'ending-chat-epilogue-btn',
  'ending-chat-evidence-drawer',
  'worldline-roundtable-shell', 'worldline-roundtable-card',
  'worldline-roundtable-picker-branch', 'worldline-roundtable-picker-card',
  'worldline-roundtable-transcript-copy', 'worldline-roundtable-transcript-header',
  'worldline-roundtable-transcript-list', 'worldline-roundtable-hero',
  'theater-panel', 'phaser-game-container', 'gameplay-modal',
  'capture-status', 'mode-btn',
]);

/** Class-merge function names to inspect */
const MERGE_FN_NAMES = new Set(['cn', 'clsx', 'twMerge']);

/** @param {string} token */
function isBemToken(token) {
  // Tokens with __ or -- are always BEM
  if (/^[a-z][\w-]*(?:__[\w-]+|--[\w-]+)/.test(token)) return true;
  // Known BEM block classes
  if (KNOWN_BEM_BLOCKS.has(token)) return true;
  return false;
}

/** @param {string} token */
function isTailwindToken(token) {
  if (TAILWIND_PREFIXES.some(p => token.startsWith(p))) return true;
  const segments = token.split(':');
  if (segments.length > 1) {
    const base = segments.at(-1);
    if (base && isTailwindToken(base)) return true;
  }
  for (const mod of TAILWIND_MODIFIERS) {
    if (token.startsWith(mod)) {
      const rest = token.slice(mod.length);
      if (TAILWIND_PREFIXES.some(p => rest.startsWith(p))) return true;
      if (TAILWIND_EXACT.has(rest)) return true;
    }
  }
  if (TAILWIND_EXACT.has(token)) return true;
  return false;
}

/** @param {string} classString */
function checkMixing(classString) {
  const tokens = classString.split(/\s+/).filter(Boolean);
  const bemTokens = tokens.filter(isBemToken);
  const twTokens = tokens.filter(isTailwindToken);
  if (bemTokens.length > 0 && twTokens.length > 0) {
    return { bem: bemTokens[0], tw: twTokens[0] };
  }
  return null;
}

/**
 * Extract static string tokens from a simple string-bearing AST node.
 * @param {import('eslint').Rule.Node} node
 * @returns {string[]}
 */
function extractTokensFromNode(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value.split(/\s+/).filter(Boolean);
  }
  if (node.type === 'TemplateLiteral') {
    const raw = node.quasis.map(q => q.value.raw).join(' ');
    return raw.split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Extract static class tokens from an object property key.
 * Supports quoted keys, identifiers, and static template literals.
 * @param {import('eslint').Rule.Node} key
 * @returns {string[]}
 */
function extractTokensFromKey(key) {
  if (key.type === 'Identifier') {
    return key.name.split(/\s+/).filter(Boolean);
  }
  return extractTokensFromNode(key);
}

/**
 * Merge two token-set lists.
 * Each inner array represents a set of classes that may co-exist at runtime.
 * @param {string[][]} baseSets
 * @param {string[][]} extraSets
 * @returns {string[][]}
 */
function mergeTokenSets(baseSets, extraSets) {
  const nextSets = [];
  for (const base of baseSets) {
    for (const extra of extraSets) {
      nextSets.push([...base, ...extra]);
    }
  }
  return nextSets;
}

/**
 * Recursively extract possible co-existing class token sets from an expression.
 * This catches nested cn/clsx/twMerge calls, object arguments, arrays, and
 * conditional branches without trying to solve arbitrary data flow.
 * @param {import('eslint').Rule.Node} expr
 * @returns {string[][]}
 */
function extractTokenSets(expr) {
  const directTokens = extractTokensFromNode(expr);
  if (directTokens.length > 0) {
    return [directTokens];
  }

  if (expr.type === 'ArrayExpression') {
    let tokenSets = [[]];
    for (const el of expr.elements) {
      if (!el) continue;
      tokenSets = mergeTokenSets(tokenSets, extractTokenSets(el));
    }
    return tokenSets;
  }

  if (expr.type === 'ObjectExpression') {
    let tokenSets = [[]];
    for (const prop of expr.properties) {
      if (prop.type === 'SpreadElement') {
        tokenSets = mergeTokenSets(tokenSets, extractTokenSets(prop.argument));
        continue;
      }

      if (prop.type !== 'Property') continue;

      const keyTokens = prop.computed ? extractTokensFromNode(prop.key) : extractTokensFromKey(prop.key);
      const value = prop.value;

      if (value.type === 'Literal' && value.value === false) {
        continue;
      }

      tokenSets = mergeTokenSets(tokenSets, [keyTokens]);
    }
    return tokenSets;
  }

  if (expr.type === 'CallExpression') {
    const callee = expr.callee;
    const name = callee.type === 'Identifier' ? callee.name : null;
    if (!name || !MERGE_FN_NAMES.has(name)) {
      return [[]];
    }

    let tokenSets = [[]];
    for (const arg of expr.arguments) {
      tokenSets = mergeTokenSets(tokenSets, extractTokenSets(arg));
    }
    return tokenSets;
  }

  if (expr.type === 'ConditionalExpression') {
    return [
      ...extractTokenSets(expr.consequent),
      ...extractTokenSets(expr.alternate),
    ];
  }

  if (expr.type === 'LogicalExpression') {
    if (expr.operator === '&&') {
      return [
        [],
        ...extractTokenSets(expr.right),
      ];
    }
    return [
      ...extractTokenSets(expr.left),
      ...extractTokenSets(expr.right),
    ];
  }

  return [[]];
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow mixing BEM classes and Tailwind utilities on the same className',
    },
    messages: {
      mixDetected:
        "Do not mix BEM class '{{bem}}' and Tailwind utility '{{tw}}' on the same element.",
    },
    schema: [],
  },
  create(context) {
    /**
     * Check one or more possible class-token sets for BEM + Tailwind mixing.
     * @param {import('eslint').Rule.Node} reportNode
     * @param {string[][]} tokenSets
     */
    function checkTokens(reportNode, tokenSets) {
      for (const tokens of tokenSets) {
        const bemTokens = tokens.filter(isBemToken);
        const twTokens = tokens.filter(isTailwindToken);
        if (bemTokens.length > 0 && twTokens.length > 0) {
          context.report({
            node: reportNode,
            messageId: 'mixDetected',
            data: { bem: bemTokens[0], tw: twTokens[0] },
          });
          return;
        }
      }
    }

    /**
     * Resolve a className value expression — handles string, template, and
     * cn/clsx/twMerge calls.
     * @param {import('eslint').Rule.Node} reportNode - the JSXAttribute node for reporting
     * @param {import('eslint').Rule.Node} expr - the expression to inspect
     */
    function inspectExpression(reportNode, expr) {
      // Direct string literal
      if (expr.type === 'Literal' && typeof expr.value === 'string') {
        const mix = checkMixing(expr.value);
        if (mix) {
          context.report({ node: reportNode, messageId: 'mixDetected', data: mix });
        }
        return;
      }

      // Template literal
      if (expr.type === 'TemplateLiteral') {
        const staticParts = expr.quasis.map(q => q.value.raw).join(' ');
        const mix = checkMixing(staticParts);
        if (mix) {
          context.report({ node: reportNode, messageId: 'mixDetected', data: mix });
        }
        return;
      }

      const tokenSets = extractTokenSets(expr);
      checkTokens(reportNode, tokenSets);
    }

    return {
      JSXAttribute(node) {
        if (node.name.name !== 'className') return;

        const value = node.value;
        if (!value) return;

        // String literal: className="btn bg-primary"
        if (value.type === 'Literal' && typeof value.value === 'string') {
          const mix = checkMixing(value.value);
          if (mix) {
            context.report({ node, messageId: 'mixDetected', data: mix });
          }
          return;
        }

        // JSX expression container
        if (value.type === 'JSXExpressionContainer') {
          inspectExpression(node, value.expression);
        }
      },
    };
  },
};

export default rule;
