#ifndef EM_PORT_API
#	if defined(__EMSCRIPTEN__)
#		include <emscripten.h>
#		if defined(__cplusplus)
#			define EM_PORT_API(rettype) extern "C" rettype EMSCRIPTEN_KEEPALIVE
#		else
#			define EM_PORT_API(rettype) rettype EMSCRIPTEN_KEEPALIVE
#		endif
#	else
#		if defined(__cplusplus)
#			define EM_PORT_API(rettype) extern "C" rettype
#		else
#			define EM_PORT_API(rettype) rettype
#		endif
#	endif
#endif


#include <math.h>
#include <string.h>
#include <stdlib.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/display.h>
#include <libavutil/error.h>
#include <libavutil/ffversion.h>
#include <jansson.h>

AVOutputFormat *ofmt = NULL;
AVFormatContext *ifmt_ctx = NULL, *ofmt_ctx = NULL;

double get_time(int64_t ts, const AVRational *time_base)
{
    if (ts == AV_NOPTS_VALUE) {
        return -1;
    } else {
        return ts * av_q2d(*time_base);
    }
}


double get_rotation(AVStream *st)
{
    uint8_t* displaymatrix = av_stream_get_side_data(st, AV_PKT_DATA_DISPLAYMATRIX, NULL);
    double theta = 0;
    if (displaymatrix)
        theta = -av_display_rotation_get((int32_t*) displaymatrix);

    theta -= 360*floor(theta/360 + 0.9/360);

    return theta;
}

void show_format(AVFormatContext** p_fmt_ctx, json_t* json_obj)
{
    AVFormatContext* fmt_ctx = *p_fmt_ctx;
    int64_t size = fmt_ctx->pb ? avio_size(fmt_ctx->pb) : -1;
    json_t* format_info = json_object();
    json_object_set(format_info, "nb_streams", json_integer(fmt_ctx->nb_streams));
    json_object_set(format_info, "nb_programs", json_integer(fmt_ctx->nb_programs));
    json_object_set(format_info, "format_name", json_string(fmt_ctx->iformat->name));
    double start_time = get_time(fmt_ctx->start_time, &AV_TIME_BASE_Q);
    json_object_set(format_info, "start_time", start_time < 0 ? json_null() : json_real(start_time));
    double duration = get_time(fmt_ctx->duration, &AV_TIME_BASE_Q);
    json_object_set(format_info, "duration", duration < 0 ? json_null() : json_real(duration));
    json_object_set(format_info, "bit_rate", json_integer(fmt_ctx->bit_rate > 0 ? fmt_ctx->bit_rate : 0));
    json_object_set(format_info, "probe_score", json_integer(fmt_ctx->probe_score));
    json_object_set(format_info, "size", json_integer(size >= 0 ? size : 0));
    json_object_set(json_obj, "format", format_info);
}

static const char* get_file_media_info(const char* filename)
{
    json_t* res_obj = json_object();
    AVDictionary *options = NULL;
    av_dict_set(&options,"rotate", "0", 0);
    ifmt_ctx = NULL;
    int open_input_err = avformat_open_input(&ifmt_ctx, filename, NULL, &options);
    if (open_input_err < 0) {
        char errbuf[128];
        const char *errbuf_ptr = errbuf;
        if (av_strerror(open_input_err, errbuf, sizeof(errbuf)) < 0)
            errbuf_ptr = strerror(AVUNERROR(open_input_err));
        json_object_set(res_obj, "err_message", json_string(errbuf_ptr));
        json_object_set(res_obj, "err_type", json_string("CANNOT_OPEN_INPUT_FILE"));
        av_log(NULL, AV_LOG_ERROR, "Cannot open input file\n");
        return json_dumps(res_obj, JSON_COMPACT);
    }

    if (avformat_find_stream_info(ifmt_ctx, NULL) < 0) {
        av_log(NULL, AV_LOG_ERROR, "Cannot find stream information\n");
        return "{\"err_type\":\"NO_STREAM_INFORMATION\"}";
    }
    json_object_set(res_obj, "err_type", json_string(""));
    show_format(&ifmt_ctx, res_obj);
    json_t* stream_arr = json_array();
    for (int i = 0; i < ifmt_ctx->nb_streams; i++) {
        json_t* stream_info = json_object();
        AVStream *stream = ifmt_ctx->streams[i];
        const AVCodecDescriptor *descriptor = avcodec_descriptor_get(stream->codecpar->codec_id);
        const char* s;
        s = av_get_media_type_string(stream->codecpar->codec_type);
        if (s) {
            json_object_set(stream_info, "codec_type", json_string(s));
        } else {
            json_object_set(stream_info, "codec_type", json_string(""));
        }
        if (descriptor) {
            json_object_set(stream_info, "codec_name", json_string(descriptor->name));
        } else {
            json_object_set(stream_info, "codec_name", json_string(""));
        }
        double duration = get_time(stream->duration, &stream->time_base);
        json_object_set(stream_info, "duration", duration < 0 ? json_null() : json_real(duration));
        if (stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            int width = stream->codecpar->width;
            int height = stream->codecpar->height;
            json_object_set(stream_info, "width", json_integer(width));
            json_object_set(stream_info, "height", json_integer(height));
            json_object_set(stream_info, "rotation", json_real(get_rotation(stream)));
            AVRational sar, dar;
            sar = av_guess_sample_aspect_ratio(ifmt_ctx, stream, NULL);
            if (sar.num) {
                json_object_set(stream_info, "sample_aspect_ratio", json_sprintf("%d:%d", sar.num, sar.den));
                av_reduce(&dar.num, &dar.den,
                    stream->codecpar->width  * sar.num,
                    stream->codecpar->height * sar.den,
                    1024*1024);
                json_object_set(stream_info ,"display_aspect_ratio", json_sprintf("%d:%d", dar.num, dar.den));
            } else {
                json_object_set(stream_info, "sample_aspect_ratio", json_string(""));
                json_object_set(stream_info, "display_aspect_ratio", json_string(""));
            }
        }
        json_array_append(stream_arr, stream_info);
    }
    json_object_set(res_obj, "streams", stream_arr);
    return json_dumps(res_obj, JSON_COMPACT);
}


EM_PORT_API(int) convertToMP3 (const char* in_filename) {
    AVOutputFormat *ofmt = NULL;
    AVFormatContext *ifmt_ctx = NULL, *ofmt_ctx = NULL;
    AVPacket pkt;
    const char* out_filename = "output.mp3";
    int ret, i;
    int stream_index = 0;
    int *stream_mapping = NULL;
    int stream_mapping_size = 0;

    if ((ret = avformat_open_input(&ifmt_ctx, in_filename, 0, 0)) < 0) {
        fprintf(stderr, "Could not open input file '%s'", in_filename);
        goto end;
    }

    if ((ret = avformat_find_stream_info(ifmt_ctx, 0)) < 0) {
        fprintf(stderr, "Failed to retrieve input stream information");
        goto end;
    }

    av_dump_format(ifmt_ctx, 0, in_filename, 0);

    avformat_alloc_output_context2(&ofmt_ctx, NULL, NULL, out_filename);
    if (!ofmt_ctx) {
        fprintf(stderr, "Could not create output context\n");
        ret = AVERROR_UNKNOWN;
        goto end;
    }

    stream_mapping_size = ifmt_ctx->nb_streams;
    stream_mapping = av_mallocz_array(stream_mapping_size, sizeof(*stream_mapping));
    if (!stream_mapping) {
        ret = AVERROR(ENOMEM);
        goto end;
    }

    ofmt = ofmt_ctx->oformat;

    for (i = 0; i < ifmt_ctx->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = ifmt_ctx->streams[i];
        AVCodecParameters *in_codecpar = in_stream->codecpar;

        if (in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
            in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO &&
            in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE) {
            stream_mapping[i] = -1;
            continue;
        }

        stream_mapping[i] = stream_index++;

        out_stream = avformat_new_stream(ofmt_ctx, NULL);
        if (!out_stream) {
            fprintf(stderr, "Failed allocating output stream\n");
            ret = AVERROR_UNKNOWN;
            goto end;
        }

        ret = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
        if (ret < 0) {
            fprintf(stderr, "Failed to copy codec parameters\n");
            goto end;
        }
        out_stream->codecpar->codec_tag = 0;
    }
    av_dump_format(ofmt_ctx, 0, out_filename, 1);

    if (!(ofmt->flags & AVFMT_NOFILE)) {
        ret = avio_open(&ofmt_ctx->pb, out_filename, AVIO_FLAG_WRITE);
        if (ret < 0) {
            fprintf(stderr, "Could not open output file '%s'", out_filename);
            goto end;
        }
    }

    ret = avformat_write_header(ofmt_ctx, NULL);
    if (ret < 0) {
        fprintf(stderr, "Error occurred when opening output file\n");
        goto end;
    }

    while (1) {
        AVStream *in_stream, *out_stream;

        ret = av_read_frame(ifmt_ctx, &pkt);
        if (ret < 0)
            break;

        in_stream  = ifmt_ctx->streams[pkt.stream_index];
        if (pkt.stream_index >= stream_mapping_size ||
            stream_mapping[pkt.stream_index] < 0) {
            av_packet_unref(&pkt);
            continue;
        }

        pkt.stream_index = stream_mapping[pkt.stream_index];
        out_stream = ofmt_ctx->streams[pkt.stream_index];
        // log_packet(ifmt_ctx, &pkt, "in");

        /* copy packet */
        pkt.pts = av_rescale_q_rnd(pkt.pts, in_stream->time_base, out_stream->time_base, AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX);
        pkt.dts = av_rescale_q_rnd(pkt.dts, in_stream->time_base, out_stream->time_base, AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX);
        pkt.duration = av_rescale_q(pkt.duration, in_stream->time_base, out_stream->time_base);
        pkt.pos = -1;
        // log_packet(ofmt_ctx, &pkt, "out");

        ret = av_interleaved_write_frame(ofmt_ctx, &pkt);
        if (ret < 0) {
            fprintf(stderr, "Error muxing packet\n");
            break;
        }
        av_packet_unref(&pkt);
    }

    av_write_trailer(ofmt_ctx);
end:

    avformat_close_input(&ifmt_ctx);

    /* close output */
    if (ofmt_ctx && !(ofmt->flags & AVFMT_NOFILE))
        avio_closep(&ofmt_ctx->pb);
    avformat_free_context(ofmt_ctx);

    av_freep(&stream_mapping);

    if (ret < 0 && ret != AVERROR_EOF) {
        fprintf(stderr, "Error occurred: %s\n", av_err2str(ret));
        return 1;
    }

    return 0;
}

int main(){

    fprintf(stdout, "ffmpeg init done\n");
    return 0;

}

EM_PORT_API(const char*) version()
{
  return FFMPEG_VERSION;
}

EM_PORT_API(const char*) mediaInfo(char * filename) {
    const char* res = get_file_media_info(filename);
    avformat_close_input(&ifmt_ctx);
    return res;
}