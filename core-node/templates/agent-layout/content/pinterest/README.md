# content/pinterest/

**Pinterest-specific output. Cross-brand by design.**

Pinterest doesn't fit the brand-folder convention because pins are
typed by purpose, not by brand. A merch pin might cover all your
brands at once.

## Convention

```
content/pinterest/
├── blog pins/         # pins that drive traffic to blog posts
├── generated pins/    # AI-generated visual pins
├── ai-generated-pins/ # alternate name for the same thing
├── merch pins/        # pins for merch / product
├── pin png assets/    # source assets used to compose pins
├── trends/            # trend research / inspiration
├── video pins/        # video pins
└── videos to edit down for pin/  # raw videos to repurpose into pins
```

## What the agent knows

For files under `pinterest/<pin_type>/`, the agent infers:
- `category=pin`
- `metadata.platform=pinterest`
- `metadata.pin_type=<pin_type>`  (e.g. "blog pins", "merch pins")

When you ask "show me unposted blog pins," the query filters on both
category and pin_type automatically.
