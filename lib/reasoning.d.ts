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
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** One selectable thinking level. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/**
 * A reasoning declaration: either `false`, meaning the model does not reason,
 * or a map from offered level to the spelling dispatch sends on the wire.
 * `off` alone may map to `null` — "supported, send nothing" — because for most
 * providers not thinking is the parameter's absence.
 */
export type EffortsDeclaration = false | Readonly<Record<string, string | null>>;
/** One operator rule. */
export interface ReasoningRule {
    /** Glob matched against the provider route key; `*` matches every route. */
    provider: string;
    /** Glob matched against the model id; `*` matches every model. */
    model: string;
    /** What to declare for a matching model that has no declaration. */
    efforts: EffortsDeclaration;
}
/** The reasoning policy one pass runs under. */
export interface ReasoningPolicy {
    /** Whether the pass may declare anything at all. */
    enabled: boolean;
    /** Rules in order; the first match wins. */
    rules: readonly ReasoningRule[];
}
/** A rule whose declaration survived validation. */
export interface CompiledRule {
    provider: string;
    model: string;
    efforts: false | Readonly<Record<string, string | null>>;
}
/** A rule that could not be used, and why. */
export interface InvalidRule {
    index: number;
    detail: string;
}
/** What the pass needs to know about one route and its models. */
export interface ReasoningFacts {
    /** The provider route key a rule's `provider` glob is matched against. */
    provider: string;
    /** Whether the installed catalog ships this model id for this route. */
    catalogKnown(id: string): boolean;
}
/** Why a model was left alone. */
export type ReasoningSkipReason = 
/** The entry already declares `reasoningEfforts`. */
'DECLARED'
/** An absent field inherits this model's catalog capability. */
 | 'CATALOG_KNOWN'
/** No configured rule matched. */
 | 'NO_RULE';
/** One model this pass declared reasoning for. */
export interface ReasoningApplication {
    id: string;
    /** The levels now offered, or `non-reasoning` for a `false` declaration. */
    levels: string[] | 'non-reasoning';
    /** Index of the rule that decided it. */
    rule: number;
}
/** The result of one reasoning pass. */
export interface ReasoningOutcome {
    /** The list to store: entries carried through, with declarations added. */
    models: unknown[];
    /** Models this pass declared reasoning for. */
    applied: ReasoningApplication[];
    /** Models deliberately left alone. */
    skipped: {
        id: string;
        reason: ReasoningSkipReason;
    }[];
}
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
export declare function matchesGlob(pattern: string, value: string): boolean;
/**
 * Validate one declaration.
 *
 * @param value - the configured value.
 * @returns the declaration, or `undefined` when it could not be used as written.
 */
export declare function compileEfforts(value: unknown): false | Readonly<Record<string, string | null>> | undefined;
/**
 * Validate a policy's rules, separating the usable ones from the rest.
 *
 * An unusable rule is reported rather than dropped in silence: a typo in a
 * level name would otherwise look like "the feature does nothing".
 *
 * @param policy - the configured policy.
 * @returns the compiled rules in order, and every rule that was refused.
 */
export declare function compileRules(policy: ReasoningPolicy): {
    rules: CompiledRule[];
    invalid: InvalidRule[];
};
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
export declare function applyReasoning(entries: readonly unknown[], rules: readonly CompiledRule[], facts: ReasoningFacts): ReasoningOutcome;
//# sourceMappingURL=reasoning.d.ts.map