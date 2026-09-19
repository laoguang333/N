use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::models::ReadingProgress;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    NotFound(String),
    ConflictCode {
        message: String,
        code: String,
    },
    ProgressProtocolUpgradeRequired {
        message: String,
        current: Option<Box<ReadingProgress>>,
    },
    ProgressConflict {
        message: String,
        current: Option<Box<ReadingProgress>>,
    },
    Internal(anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    current: Option<ReadingProgress>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message, code, current) = match self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, message, None, None),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, message, None, None),
            AppError::ConflictCode { message, code } => {
                (StatusCode::CONFLICT, message, Some(code), None)
            }
            AppError::ProgressProtocolUpgradeRequired { message, current } => (
                StatusCode::PRECONDITION_REQUIRED,
                message,
                Some("progress_protocol_upgrade_required".to_string()),
                current.map(|current| *current),
            ),
            AppError::ProgressConflict { message, current } => (
                StatusCode::CONFLICT,
                message,
                Some("progress_conflict".to_string()),
                current.map(|current| *current),
            ),
            AppError::Internal(error) => {
                tracing::error!("{error:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                    None,
                    None,
                )
            }
        };

        (
            status,
            Json(ErrorBody {
                error: message,
                code,
                current,
            }),
        )
            .into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self::Internal(error.into())
    }
}
