#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#import <VideoToolbox/VideoToolbox.h>

#if __MAC_OS_X_VERSION_MAX_ALLOWED < 260000
#error "Apple AI requires the macOS 26 SDK. Select Xcode 26 or newer with xcode-select."
#endif



API_AVAILABLE(macos(26.0))
@interface BPAppleScaler : NSObject {
@public
    VTFrameProcessor *processor;
    CIContext *imageContext;
    CVPixelBufferRef rgbSource;
    CVPixelBufferRef rgbOutput;
    CVPixelBufferRef source;
    CVPixelBufferRef output;
    CGColorSpaceRef colorSpace;
}
@end

@implementation BPAppleScaler
- (void)dealloc {
    [processor endSession];
    if (rgbSource) CVPixelBufferRelease(rgbSource);
    if (rgbOutput) CVPixelBufferRelease(rgbOutput);
    if (source) CVPixelBufferRelease(source);
    if (output) CVPixelBufferRelease(output);
    if (colorSpace) CGColorSpaceRelease(colorSpace);
}
@end

static void setError(char *error, size_t capacity, NSString *message) {
    if (capacity) snprintf(error, capacity, "%s", message.UTF8String);
}

int32_t bp_apple_scaler_supported(void) {
    @autoreleasepool {
        if (@available(macOS 26.0, *)) {
            return VTLowLatencySuperResolutionScalerConfiguration.isSupported;
        }
        return -1;
    }
}

float bp_apple_scaler_factor(uint32_t width, uint32_t height, float requested) {
    @autoreleasepool {
        if (@available(macOS 26.0, *)) {
            NSArray<NSNumber *> *factors = [VTLowLatencySuperResolutionScalerConfiguration
                supportedScaleFactorsForFrameWidth:width frameHeight:height];
            float best = 0;
            for (NSNumber *value in factors) {
                float f = value.floatValue;
                if (f <= 1) continue;
                if (best == 0 || (best < requested && f > best) || (f >= requested && f < best)) best = f;
            }
            return best;
        }
        return 0;
    }
}

static CVPixelBufferRef pixelBuffer(NSDictionary *attributes) {
    CVPixelBufferRef buffer = NULL;
    CVReturn result = CVPixelBufferCreate(kCFAllocatorDefault,
        [attributes[(id)kCVPixelBufferWidthKey] unsignedIntValue],
        [attributes[(id)kCVPixelBufferHeightKey] unsignedIntValue],
        [attributes[(id)kCVPixelBufferPixelFormatTypeKey] unsignedIntValue],
        (__bridge CFDictionaryRef)attributes, &buffer);
    return result == kCVReturnSuccess ? buffer : NULL;
}

static CVPixelBufferRef rgbBuffer(uint32_t width, uint32_t height) {
    return pixelBuffer(@{
        (id)kCVPixelBufferWidthKey: @(width),
        (id)kCVPixelBufferHeightKey: @(height),
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
        (id)kCVPixelBufferMetalCompatibilityKey: @YES,
        (id)kCVPixelBufferOpenGLCompatibilityKey: @YES,
    });
}

API_AVAILABLE(macos(26.0))
static bool processFrame(BPAppleScaler *scaler, NSError **error) {
    CIImage *input = [CIImage imageWithCVPixelBuffer:scaler->rgbSource options:@{
        kCIImageColorSpace: (__bridge id)scaler->colorSpace,
    }];
    [scaler->imageContext render:input toCVPixelBuffer:scaler->source bounds:input.extent colorSpace:scaler->colorSpace];
    VTFrameProcessorFrame *sourceFrame = [[VTFrameProcessorFrame alloc] initWithBuffer:scaler->source presentationTimeStamp:kCMTimeZero];
    VTFrameProcessorFrame *destinationFrame = [[VTFrameProcessorFrame alloc] initWithBuffer:scaler->output presentationTimeStamp:kCMTimeZero];
    VTLowLatencySuperResolutionScalerParameters *parameters = [[VTLowLatencySuperResolutionScalerParameters alloc]
        initWithSourceFrame:sourceFrame destinationFrame:destinationFrame];
    if (![scaler->processor processWithParameters:parameters error:error]) return false;
    CIImage *output = [CIImage imageWithCVPixelBuffer:scaler->output];
    [scaler->imageContext render:output toCVPixelBuffer:scaler->rgbOutput bounds:output.extent colorSpace:scaler->colorSpace];
    return true;
}


void *bp_apple_scaler_create(uint32_t width, uint32_t height, float factor, char *error, size_t capacity) {
    @autoreleasepool {
        @try {
            if (@available(macOS 26.0, *)) {
                BPAppleScaler *scaler = [BPAppleScaler new];
                VTLowLatencySuperResolutionScalerConfiguration *config = [[VTLowLatencySuperResolutionScalerConfiguration alloc]
                    initWithFrameWidth:width frameHeight:height scaleFactor:factor];
                scaler->processor = [VTFrameProcessor new];
                NSError *failure = nil;
                if (![scaler->processor startSessionWithConfiguration:config error:&failure]) {
                    setError(error, capacity, failure.localizedDescription ?: @"Apple AI unavailable");
                    return NULL;
                }
                scaler->source = pixelBuffer(config.sourcePixelBufferAttributes);
                scaler->output = pixelBuffer(config.destinationPixelBufferAttributes);
                scaler->rgbSource = rgbBuffer(width, height);
                scaler->rgbOutput = rgbBuffer(lroundf(width * factor), lroundf(height * factor));
                if (!scaler->source || !scaler->output || !scaler->rgbSource || !scaler->rgbOutput) {
                    setError(error, capacity, @"Pixel allocation failed");
                    return NULL;
                }
                scaler->colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
                for (id buffer in @[(__bridge id)scaler->source, (__bridge id)scaler->output]) {
                    CVBufferSetAttachment((__bridge CVBufferRef)buffer, kCVImageBufferYCbCrMatrixKey,
                        kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
                    CVBufferSetAttachment((__bridge CVBufferRef)buffer, kCVImageBufferColorPrimariesKey,
                        kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
                    CVBufferSetAttachment((__bridge CVBufferRef)buffer, kCVImageBufferTransferFunctionKey,
                        kCVImageBufferTransferFunction_sRGB, kCVAttachmentMode_ShouldPropagate);
                }
                id<MTLDevice> device = MTLCreateSystemDefaultDevice();
                if (!device) {
                    setError(error, capacity, @"Metal unavailable");
                    return NULL;
                }
                scaler->imageContext = [CIContext contextWithMTLDevice:device options:@{
                    kCIContextWorkingColorSpace: (__bridge id)scaler->colorSpace,
                    kCIContextCacheIntermediates: @NO,
                }];

                CIImage *black = [CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:0 alpha:1]];
                [scaler->imageContext render:black toCVPixelBuffer:scaler->rgbSource
                    bounds:CGRectMake(0, 0, width, height) colorSpace:scaler->colorSpace];
                if (!processFrame(scaler, &failure)) {
                    setError(error, capacity, failure.localizedDescription ?: @"Apple AI unavailable");
                    return NULL;
                }
                return (__bridge_retained void *)scaler;
            }
            setError(error, capacity, @"Requires macOS 26");
            return NULL;
        } @catch (NSException *exception) {
            setError(error, capacity, exception.reason ?: @"Apple AI unavailable");
            return NULL;
        }
    }
}


bool bp_apple_scaler_bind(void *handle, bool destination, char *error, size_t capacity) {
    @autoreleasepool {
        if (@available(macOS 26.0, *)) {
            BPAppleScaler *scaler = (__bridge BPAppleScaler *)handle;
            CVPixelBufferRef buffer = destination ? scaler->rgbOutput : scaler->rgbSource;
            CGLError result = CGLTexImageIOSurface2D(CGLGetCurrentContext(), GL_TEXTURE_RECTANGLE, GL_RGBA8,
                (GLsizei)CVPixelBufferGetWidth(buffer), (GLsizei)CVPixelBufferGetHeight(buffer),
                GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, CVPixelBufferGetIOSurface(buffer), 0);
            if (result == kCGLNoError) return true;
            setError(error, capacity, [NSString stringWithUTF8String:CGLErrorString(result)]);
        }
        return false;
    }
}

bool bp_apple_scaler_process(void *handle, char *error, size_t capacity) {
    @autoreleasepool {
        @try {
            if (@available(macOS 26.0, *)) {
                BPAppleScaler *scaler = (__bridge BPAppleScaler *)handle;
                NSError *failure = nil;
                if (!processFrame(scaler, &failure)) {
                    setError(error, capacity, failure.localizedDescription ?: @"Apple AI failed");
                    return false;
                }
                return true;
            }
            return false;
        } @catch (NSException *exception) {
            setError(error, capacity, exception.reason ?: @"Apple AI failed");
            return false;
        }
    }
}

void bp_apple_scaler_destroy(void *handle) {
    @autoreleasepool {
        if (@available(macOS 26.0, *)) {
            BPAppleScaler *scaler = (__bridge_transfer BPAppleScaler *)handle;
            (void)scaler;
        }
    }
}
