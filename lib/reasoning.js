/**
 * Reasoning-effort declaration for models that have none.
 *
 * A route pi-ai's catalog does not describe has to declare everything itself,
 * and the one field with no sensible default is `reasoningEfforts`. Measured
 * against a real boot: a third-party model that omits it resolves to
 * `reasoning: null` — the model offers no thinking level at all, and no
 * selector can offer one. Declaring the map by hand works, but every model on
 * every gateway then has to be written out again whenever one is added.
 *
 * This module closes that gap without guessing. It fills a declaration in for
 * exactly the models that have none, using rules the operator writes:
 *
 * - An entry that already declares `reasoningEfforts` — including `false`,
 *   which states "this model does not reason" — is **never touched**. A
 *   declaration that exists is a decision someone made.
 * - A model the installed catalog knows is **never touched** either: an absent
 *   field inherits the catalog entry's capability, so it is not missing
 *   anything.
 * - Nothing is inferred from a model's name. Levels and their wire spellings
 *   are the operator's statement about their gateway, because the wire
 *   spelling is a property of the endpoint that no listing discloses.
 *
 * What is left is a model with no declaration and no catalog entry — a
 * third-party model that cannot reason today — and a rule that says what it
 * should offer.
 *
 * @module dsh-llm-pi-ai-live/reasoning
 */
/** Every thinking level the route profile schema accepts, in escalation order. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Match one glob against one value.
 *
 * Only `*` is special, and it matches any run of characters including none.
 * Everything else is literal, so a model id containing `.`, `+`, or `(` needs
 * no escaping.
 *
 * @param pattern - the glob, which may contain `*`.
 * @param value - the candidate string.
 * @returns whether the pattern matches the whole value.
 */
export function matchesGlob(pattern, value) {
    if (pattern === '*')
        return true;
    if (!pattern.includes('*'))
        return pattern === value;
    const parts = pattern.split('*');
    let cursor = 0;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const found = value.indexOf(part, cursor);
        if (found < 0)
            return false;
        // The first fragment is anchored at the start, the last at the end.
        if (index === 0 && found !== 0)
            return false;
        cursor = found + part.length;
    }
    const last = parts[parts.length - 1];
    return last.length === 0 || value.endsWith(last);
}
/**
 * Validate one declaration.
 *
 * @param value - the configured value.
 * @returns the declaration, or `undefined` when it could not be used as written.
 */
export function compileEfforts(value) {
    if (value === false)
        return false;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const out = {};
    for (const [level, spelling] of Object.entries(value)) {
        // A schema-materialized form can carry every level with the unset ones
        // left `undefined`; an unset level simply is not offered.
        if (spelling === undefined)
            continue;
        if (!THINKING_LEVELS.includes(level))
            return undefined;
        if (spelling === null) {
            // Only `off` may carry no wire value; every other level must name one.
            if (level !== 'off')
                return undefined;
            out[level] = null;
            continue;
        }
        if (typeof spelling !== 'string' || spelling.trim().length === 0)
            return undefined;
        out[level] = spelling;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * Validate a policy's rules, separating the usable ones from the rest.
 *
 * An unusable rule is reported rather than dropped in silence: a typo in a
 * level name would otherwise look like "the feature does nothing".
 *
 * @param policy - the configured policy.
 * @returns the compiled rules in order, and every rule that was refused.
 */
export function compileRules(policy) {
    const rules = [];
    const invalid = [];
    policy.rules.forEach((rule, index) => {
        const efforts = compileEfforts(rule.efforts);
        if (efforts === undefined) {
            invalid.push({
                index,
                detail: 'efforts must be false, or a non-empty map whose keys are thinking levels ' +
                    `(${THINKING_LEVELS.join(', ')}) and whose values are wire spellings, with null allowed only for "off"`,
            });
            return;
        }
        rules.push({ provider: rule.provider, model: rule.model, efforts });
    });
    return { rules, invalid };
}
/**
 * Declare reasoning for the models that have none.
 *
 * Entries are carried through by reference unless a declaration is added, so
 * an entry that already carries one is the same object it was.
 *
 * @param entries - the model list about to be stored.
 * @param rules - compiled rules, in match order.
 * @param facts - what the installed catalog knows.
 * @returns the list to store, with what was applied and what was left alone.
 */
export function applyReasoning(entries, rules, facts) {
    const models = [];
    const applied = [];
    const skipped = [];
    for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            models.push(entry);
            continue;
        }
        const record = entry;
        const id = typeof record['id'] === 'string' ? record['id'] : undefined;
        if (id === undefined) {
            models.push(entry);
            continue;
        }
        if ('reasoningEfforts' in record) {
            skipped.push({ id, reason: 'DECLARED' });
            models.push(entry);
            continue;
        }
        if (facts.catalogKnown(id)) {
            skipped.push({ id, reason: 'CATALOG_KNOWN' });
            models.push(entry);
            continue;
        }
        const matchIndex = rules.findIndex((rule) => matchesGlob(rule.provider, facts.provider) && matchesGlob(rule.model, id));
        if (matchIndex < 0) {
            skipped.push({ id, reason: 'NO_RULE' });
            models.push(entry);
            continue;
        }
        const efforts = rules[matchIndex].efforts;
        models.push({ ...record, reasoningEfforts: efforts });
        applied.push({
            id,
            levels: efforts === false ? 'non-reasoning' : Object.keys(efforts),
            rule: matchIndex,
        });
    }
    return { models, applied, skipped };
}
//# sourceMappingURL=reasoning.js.map