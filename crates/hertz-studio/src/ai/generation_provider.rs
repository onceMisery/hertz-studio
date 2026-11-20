// SPDX-License-Identifier: MIT
//! Typed dispatch metadata; jobs remains the sole admission and execution owner.
#[cfg(any(feature = "desktop-host", test))]
use super::image_provider::ImageProvider;
use super::{
    jobs::{GenerationInput, StageIntentProvider},
    usage::PriceQuote,
};
use std::sync::Arc;

#[derive(Clone)]
pub(super) enum Provider {
    Text(Arc<dyn StageIntentProvider>),
    #[cfg(any(feature = "desktop-host", test))]
    Image(Arc<dyn ImageProvider>),
}

impl Provider {
    pub(super) fn id(&self) -> &'static str {
        match self {
            Self::Text(p) => p.id(),
            #[cfg(any(feature = "desktop-host", test))]
            Self::Image(p) => p.id(),
        }
    }
    pub(super) fn model(&self) -> &str {
        match self {
            Self::Text(p) => p.model(),
            #[cfg(any(feature = "desktop-host", test))]
            Self::Image(p) => p.model(),
        }
    }
    pub(super) fn ready(&self) -> bool {
        match self {
            Self::Text(p) => p.ready(),
            #[cfg(any(feature = "desktop-host", test))]
            Self::Image(p) => p.ready(),
        }
    }
    #[cfg(any(feature = "desktop-host", test))]
    pub(super) fn endpoint_identity(&self) -> Option<&str> {
        match self {
            Self::Text(p) => p.endpoint_identity(),
            #[cfg(any(feature = "desktop-host", test))]
            Self::Image(p) => p.endpoint_identity(),
        }
    }
    pub(super) fn requires_credential(&self) -> bool {
        match self {
            Self::Text(p) => p.requires_credential(),
            #[cfg(any(feature = "desktop-host", test))]
            Self::Image(p) => p.requires_credential(),
        }
    }
    #[cfg(any(feature = "desktop-host", test))]
    pub(super) fn supports_wallpaper(&self, input: &GenerationInput) -> bool {
        use hertz_wallpaper::generation::WallpaperGenerationKind;
        match (self, input) {
            (Self::Text(p), GenerationInput::Wallpaper(request)) => {
                request.output.kind == WallpaperGenerationKind::Builtin
                    && p.supports_wallpaper_builtin()
            }
            (Self::Text(p), GenerationInput::Composition { .. }) => {
                p.supports_wallpaper_composition()
            }
            (Self::Image(p), GenerationInput::Wallpaper(request)) => {
                request.output.kind == WallpaperGenerationKind::Image && p.ready()
            }
            _ => false,
        }
    }
    pub(super) fn quote(&self, input: &GenerationInput) -> Result<PriceQuote, String> {
        match (self, input) {
            (Self::Text(p), GenerationInput::Stage(brief)) => p.quote(brief),
            #[cfg(any(feature = "desktop-host", test))]
            (Self::Text(p), GenerationInput::Wallpaper(request)) if !input.is_image() => {
                p.quote_wallpaper_builtin(request)
            }
            #[cfg(any(feature = "desktop-host", test))]
            (
                Self::Text(p),
                GenerationInput::Composition {
                    request, assets, ..
                },
            ) => p.quote_wallpaper_composition(request, assets),
            #[cfg(any(feature = "desktop-host", test))]
            (Self::Image(p), GenerationInput::Wallpaper(request)) if input.is_image() => {
                p.quote(&super::image_provider::Input::from_request(request)?)
            }
            #[cfg(any(feature = "desktop-host", test))]
            _ => Err("provider and generation type do not match".into()),
        }
    }
}
