type VariantsConfig = Record<string, Record<string, string>>;

type VariantPropsFor<C extends VariantsConfig> = {
  [K in keyof C]?: keyof C[K] | null;
};

export type VariantProps<F> = F extends (props?: infer P) => string
  ? Omit<NonNullable<P>, "className">
  : never;

// Hand-written class-variance-authority equivalent (the npm package is not installed):
// returns a builder that joins the base class with the class for each selected variant.
export function cva<C extends VariantsConfig>(
  base: string,
  config: { variants: C; defaultVariants?: VariantPropsFor<C> },
) {
  return (props?: VariantPropsFor<C> & { className?: unknown }): string => {
    const out: string[] = [base];
    for (const key in config.variants) {
      const requested = props?.[key];
      const value =
        requested === null
          ? undefined
          : (requested ?? config.defaultVariants?.[key]);
      if (value != null) {
        const cls = config.variants[key][value as string];
        if (cls) out.push(cls);
      }
    }
    if (typeof props?.className === "string") out.push(props.className);
    return out.filter(Boolean).join(" ");
  };
}
