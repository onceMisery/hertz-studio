// SPDX-License-Identifier: MIT
//! Typed dispatch metadata; jobs remains the sole admission and execution owner.
use super::{
    image_provider::ImageProvider,
    jobs::{GenerationInput, StageIntentProvider},
    usage::PriceQuote,
};
use std::sync::Arc;

#[derive(Clone)]
pub(super) enum Provider {
    Text(Arc<dyn StageIntentProvider>),
    Image(Arc<dyn ImageProvider>),
}

impl Provider {
    pub(super) fn id(&self) -> &'static str {
        match self {
            Self::Text(p) => p.id(),
            Self::Image(p) => p.id(),
        }
    }
    pub(super) fn model(&self) -> &str {
        match self {
            Self::Text(p) => p.model(),
            Self::Image(p) => p.model(),
        }
    }
    pub(super) fn ready(&self) -> bool {
        match self {
            Self::Text(p) => p.ready(),
            Self::Image(p) => p.ready(),
        }
    }
    pub(super) fn endpoint_identity(&self) -> Option<&str> {
        match self {
            Self::Text(p) => p.endpoint_identity(),
            Self::Image(p) => p.endpoint_identity(),
        }
    }
    pub(super) fn requires_credential(&self) -> bool {
        match self {
            Self::Text(p) => p.requires_credential(),
            Self::Image(p) => p.requires_credential(),
        }
    }
    pub(super) fn supports_wallpaper(&self, input: &GenerationInput) -> bool {
        use hertz_wallpaper::generation::WallpaperGenerationKind;
        match (self, input) {
            (Self::Text(p), GenerationInput::Wallpaper(request)) => {
                request.output.kind == WallpaperGenerationKind::Builtin
                    && p.supports_wallpaper_builtin()
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
            (Self::Text(p), GenerationInput::Wallpaper(request)) if !input.is_image() => {
                p.quote_wallpaper_builtin(request)
            }
            (Self::Image(p), GenerationInput::Wallpaper(request)) if input.is_image() => {
                p.quote(&super::image_provider::Input::from_request(request)?)
            }
            _ => Err("provider and generation type do not match".into()),
        }
    }
}
